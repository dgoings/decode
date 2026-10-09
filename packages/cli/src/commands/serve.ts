import { execFileSync, spawn } from 'node:child_process';
import * as http from 'node:http';
import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import type { Snapshot } from '@codeviz/core';
import { analyzeRef } from '../analyze.ts';
import { listSnapshots, readSnapshot } from '../cache.ts';
import { loadOverlays, reportUnmatched, type Overlay } from '../overlay.ts';
import { resolveRef } from '../refs.ts';
import { repoId, repoName } from '../repo.ts';
import { type CodevizServer, createServer, handleTracePost, HOST } from '../server.ts';
import { readTrace } from '../trace/format.ts';
import { TraceStore } from '../trace/live.ts';
import { version } from '../version.ts';

export const serveUsage = 'codeviz serve [--port <n>] [--since <90d|6m|1y|YYYY-MM-DD>] [--open] [--no-analyze] [--overlay <file>]... [--trace <file>]... [--trace-listen] [--trace-port <n>]';

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
  const overlayFiles: string[] = [];
  const traceFiles: string[] = [];
  let traceListen = false;
  let tracePort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--open') open = true;
    else if (a === '--no-analyze') analyze = false;
    else if (a === '--overlay' || a.startsWith('--overlay=')) {
      const v = a === '--overlay' ? args[++i] : a.slice('--overlay='.length);
      if (!v) return fail('--overlay needs a file');
      overlayFiles.push(v);
    } else if (a === '--trace' || a.startsWith('--trace=')) {
      const v = a === '--trace' ? args[++i] : a.slice('--trace='.length);
      if (!v) return fail('--trace needs a file');
      traceFiles.push(v);
    } else if (a === '--trace-listen') traceListen = true;
    else if (a === '--trace-port' || a.startsWith('--trace-port=')) {
      const v = a === '--trace-port' ? args[++i] : a.slice('--trace-port='.length);
      tracePort = Number(v);
      if (!v || !Number.isInteger(tracePort) || tracePort <= 0 || tracePort > 65535) return fail(`invalid --trace-port ${v ?? ''}`);
      traceListen = true;
    }
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

  let overlays: Overlay[];
  try {
    overlays = loadOverlays(overlayFiles, root);
  } catch (err) {
    return fail((err as Error).message);
  }

  const traces = new TraceStore();
  for (const f of traceFiles) {
    try {
      traces.add(readTrace(f), f);
    } catch (err) {
      return fail(`cannot read trace ${f}: ${(err as Error).message}`);
    }
  }

  const log = (s: string) => console.error(s);
  let head: Snapshot | null = null;
  if (analyze) {
    try {
      const t0 = Date.now();
      const { cached, snapshot } = await analyzeRef(root, 'HEAD', { since, log });
      head = snapshot;
      log(`analyzed HEAD ${cached ? '(cached)' : `in ${Date.now() - t0}ms`}`);
    } catch (err) {
      log(`warning: could not analyze HEAD: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (overlays.length) {
    try {
      head ??= readSnapshot(repoId(root), resolveRef(root, 'HEAD').sha, version);
    } catch {
      // no HEAD commit
    }
    if (head) reportUnmatched(overlays, head.files.map((f) => f.path), log);
    else log('note: HEAD is not analyzed, so overlay paths were not checked against its files');
  }

  if (traceFiles.length) {
    try {
      head ??= readSnapshot(repoId(root), resolveRef(root, 'HEAD').sha, version);
    } catch {
      // no HEAD commit
    }
    const known = new Set(head?.files.map((f) => f.path) ?? []);
    for (const t of traces.list()) {
      const paths = new Set(traces.get(t.id)!.ticks.flatMap((tk) => tk.files.map(([p]) => p)));
      const missing = head ? [...paths].filter((p) => !known.has(p)).length : 0;
      const sha = head && t.sha !== head.sha ? ` (sha ${t.sha.slice(0, 7)}, HEAD is ${head.sha.slice(0, 7)})` : '';
      log(`trace ${t.id}: ${t.source}, ${t.ticks} ticks over ${(t.durationMs / 1000).toFixed(1)}s, ${paths.size} files${missing ? `, ${missing} not in HEAD` : ''}${sha}`);
    }
  }

  const started = await startServer({ root, since, port, log, overlays, traces, traceListen });
  if (typeof started === 'string') return fail(started);
  if (traceListen) {
    let where = `${started.url}/trace`;
    if (tracePort !== undefined) {
      const ingest = http.createServer((req, res) => {
        if (req.method === 'POST') return void handleTracePost(traces, req, res);
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`codeviz serve: live trace ingest for ${started.url}\n`);
      });
      try {
        await listen(ingest, tracePort);
      } catch (err) {
        return fail(`--trace-port ${tracePort}: ${(err as Error).message}`);
      }
      ingest.unref();
      where = `http://${HOST}:${tracePort}/trace`;
    }
    log(`live traces: set CODEVIZ_TRACE_URL=${where} for the Bun preload`);
  }
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
  overlays?: Overlay[];
  traces?: TraceStore;
  traceListen?: boolean;
}): Promise<{ server: CodevizServer; url: string } | string> {
  const { port } = opts;
  const server = createServer({ root: opts.root, since: opts.since, log: opts.log, worktree: opts.worktree, overlays: opts.overlays, traces: opts.traces, traceListen: opts.traceListen });
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
      if (stopping) return;
      stopping = true;
      console.error('codeviz: shutting down');
      server.close();
      server.closeAllConnections?.();
      // Never exit mid-analysis: each analysis child must get to remove its temporary git worktree.
      // Forward the signal (a terminal Ctrl-C already reaches the children; a `kill -INT` does not).
      server.interrupt();
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
