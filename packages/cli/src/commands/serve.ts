import { execFileSync, spawn } from 'node:child_process';
import type * as http from 'node:http';
import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import type { Snapshot } from '@codeviz/core';
import { analyzeRef } from '../analyze.ts';
import { listSnapshots } from '../cache.ts';
import { repoId, repoName } from '../repo.ts';
import { type CodevizServer, createServer, HOST } from '../server.ts';

export const serveUsage = 'codeviz serve [--port <n>] [--since <90d|6m|1y|YYYY-MM-DD>] [--open] [--no-analyze]';

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore: opening a browser is best effort
  }
}

export async function serveCommand(args: string[]): Promise<number> {
  let port = 4173;
  let since = DEFAULT_SINCE;
  let open = false;
  let analyze = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--open') open = true;
    else if (a === '--no-analyze') analyze = false;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a === '--port' ? args[++i] : a.slice('--port='.length);
      port = Number(v);
      if (!v || !Number.isInteger(port) || port < 0 || port > 65535) return fail(`invalid --port ${v ?? ''}`);
    } else if (a === '--since') {
      const v = args[++i];
      if (!v) return fail('--since needs a value');
      since = v;
    } else if (a.startsWith('--since=')) since = a.slice('--since='.length);
    else return fail(`unknown argument ${a}\nusage: ${serveUsage}`, 2);
  }
  try {
    parseSince(since);
  } catch (err) {
    return fail((err as Error).message);
  }

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fail('not inside a git repository');
  }

  const log = (s: string) => console.error(s);
  if (analyze) {
    try {
      const t0 = Date.now();
      const { cached } = await analyzeRef(root, 'HEAD', { since, log });
      log(`analyzed HEAD ${cached ? '(cached)' : `in ${Date.now() - t0}ms`}`);
    } catch (err) {
      log(`warning: could not analyze HEAD: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const started = await startServer({ root, since, port, log });
  if (typeof started === 'string') return fail(started);
  console.log(`codeviz serve: ${started.url}  (repo ${repoName(root)}, ${listSnapshots(repoId(root)).length} snapshots cached)`);
  if (open) openBrowser(started.url);
  return untilSigint(started.server);
}

/** Create the server and bind it to `port` (or the next free one of 10). Returns an error message on failure. */
export async function startServer(opts: {
  root: string;
  since: string;
  port: number;
  log: (s: string) => void;
  worktree?: Snapshot | null;
}): Promise<{ server: CodevizServer; url: string } | string> {
  const { port } = opts;
  const server = createServer({ root: opts.root, since: opts.since, log: opts.log, worktree: opts.worktree });
  let bound: number | undefined;
  for (let attempt = 0; attempt < 10 && bound === undefined; attempt++) {
    try {
      bound = await listen(server, port === 0 ? 0 : port + attempt);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') return (err as Error).message;
    }
  }
  if (bound === undefined) return `no free port in ${port}-${port + 9}`;
  return { server, url: `http://${HOST}:${bound}` };
}

/** Serve until SIGINT, then wait for in-flight analysis (capped at 15s) and exit 0. */
export function untilSigint(server: CodevizServer): Promise<number> {
  return new Promise<number>((resolve) => {
    let stopping = false;
    process.on('SIGINT', () => {
      if (stopping) return; // a pending analysis' own SIGINT handler cleans up its temp worktree
      stopping = true;
      console.error('codeviz: shutting down');
      server.close();
      server.closeAllConnections?.();
      // Never exit mid-analysis: withCheckout must get to remove its temporary git worktree.
      const cap = new Promise<void>((r) => setTimeout(r, 15_000).unref());
      void Promise.race([server.idle(), cap]).then(() => {
        resolve(0);
        process.exit(0);
      });
    });
  });
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz serve: ${msg}`);
  return code;
}
