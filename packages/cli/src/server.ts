import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { encodeSnapshot, type Snapshot } from '@codeviz/core';
import { analyzeRef } from './analyze.ts';
import { cacheDir, listSnapshots } from './cache.ts';
import { compareRefs } from './compare.ts';
import { resolveRef } from './refs.ts';
import { repoId, repoName } from './repo.ts';

export interface ServerOptions {
  root: string;
  since: string;
  log?: (s: string) => void;
  /** Seed the in-memory WORKTREE snapshot (e.g. from `codeviz compare HEAD WORKTREE --open`). */
  worktree?: Snapshot | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>codeviz</title></head>
<body style="font-family:system-ui;padding:2rem"><h1>codeviz</h1>
<p>The web UI is not built. Run <code>bun run build</code>. The API is available at <a href="/api/snapshots">/api/snapshots</a>.</p>
</body></html>`;

/** Directory holding the built web UI: dist/web next to the bundle, or packages/web/dist in dev. */
function findWebDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'web'), // dist/cli.js -> dist/web
    path.resolve(here, '../../web/dist'), // packages/cli/src -> packages/web/dist
    path.resolve(here, '../packages/web/dist'), // dist/cli.js inside the codeviz checkout
  ];
  return candidates.find((d) => existsSync(path.join(d, 'index.html'))) ?? null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function listRefs(root: string): { name: string; sha: string; kind: 'branch' | 'tag' }[] {
  // %(*objectname) is the peeled commit for annotated tags.
  const out = git(root, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname) %(*objectname) %(refname)',
    'refs/heads',
    'refs/tags',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, peeled, full] = line.split(' ');
      return { name: name!, sha: peeled || sha!, kind: full!.startsWith('refs/tags/') ? ('tag' as const) : ('branch' as const) };
    });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function sendGzippedJson(req: http.IncomingMessage, res: http.ServerResponse, gz: Buffer): void {
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const body = accepts ? gz : gunzipSync(gz);
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    Vary: 'Accept-Encoding',
  };
  if (accepts) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export type CodevizServer = http.Server & {
  /** Resolves once no analysis is in flight (so temp worktrees have been cleaned up). */
  idle(): Promise<void>;
};

export function createServer(opts: ServerOptions): CodevizServer {
  const log = opts.log ?? (() => {});
  const root = git(opts.root, ['rev-parse', '--show-toplevel']);
  const id = repoId(root);
  const name = repoName(root);
  const webDir = findWebDir();
  let worktree: Snapshot | null = opts.worktree ?? null;
  const inFlight = new Set<string>();
  const running = new Set<Promise<unknown>>();

  /** Register work that may hold a temp worktree so `idle()` (and SIGINT shutdown) waits for it. */
  function track<T>(job: Promise<T>): Promise<T> {
    running.add(job);
    job.then(
      () => running.delete(job),
      () => running.delete(job),
    );
    return job;
  }

  async function handleAnalyze(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { ref?: unknown; force?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    const ref = body.ref;
    if (typeof ref !== 'string' || ref === '') return sendJson(res, 400, { error: 'ref is required' });
    if (inFlight.has(ref)) return sendJson(res, 409, { error: 'in progress' });
    inFlight.add(ref);
    try {
      const { snapshot, cached } = await track(analyzeRef(root, ref, { since: opts.since, log, force: body.force === true }));
      if (snapshot.sha === 'WORKTREE') worktree = snapshot;
      sendJson(res, 200, { sha: snapshot.sha, ref, cached });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(ref);
    }
  }

  async function handleCompare(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const base = url.searchParams.get('base');
    const head = url.searchParams.get('head');
    if (!base || !head) return sendJson(res, 400, { error: 'base and head are required' });
    if (base === 'WORKTREE') return sendJson(res, 400, { error: 'WORKTREE can only be the head of a comparison' });
    try {
      resolveRef(root, base);
      resolveRef(root, head);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const diff = await track(
        (async () => {
          if (head === 'WORKTREE' && !worktree) worktree = (await analyzeRef(root, 'WORKTREE', { since: opts.since, log })).snapshot;
          return compareRefs(root, base, head, { since: opts.since, log, worktree });
        })(),
      );
      sendGzippedJson(req, res, gzipSync(JSON.stringify(diff)));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleSnapshot(req: http.IncomingMessage, res: http.ServerResponse, sha: string): void {
    if (sha === 'WORKTREE') {
      if (!worktree) return sendJson(res, 404, { error: 'not analyzed' });
      return sendGzippedJson(req, res, encodeSnapshot(worktree));
    }
    if (!/^[0-9a-f]{40}$/.test(sha)) return sendJson(res, 404, { error: 'not analyzed' });
    let gz: Buffer;
    try {
      gz = readFileSync(path.join(cacheDir(id), `${sha}.json.gz`));
    } catch {
      return sendJson(res, 404, { error: 'not analyzed' });
    }
    sendGzippedJson(req, res, gz); // cache files are already gzipped JSON
  }

  function handleStatic(res: http.ServerResponse, pathname: string): void {
    if (!webDir) {
      res.writeHead(200, { 'Content-Type': MIME['.html']! });
      res.end(PLACEHOLDER);
      return;
    }
    let file = path.resolve(webDir, '.' + decodeURIComponent(pathname));
    if (file !== webDir && !file.startsWith(webDir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      // not found
    }
    if (!isFile) file = path.join(webDir, 'index.html');
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(body);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (p === '/api/snapshots' && method === 'GET') {
      return sendJson(res, 200, {
        repo: name,
        repoId: id,
        head: git(root, ['rev-parse', 'HEAD']),
        snapshots: listSnapshots(id),
        refs: listRefs(root),
        worktree: worktree ? { analyzedAt: worktree.analyzedAt } : null,
      });
    }
    const m = /^\/api\/snapshots\/([^/]+)$/.exec(p);
    if (m && method === 'GET') return handleSnapshot(req, res, m[1]!);
    if (p === '/api/analyze' && method === 'POST') return handleAnalyze(req, res);
    if (p === '/api/compare' && method === 'GET') return handleCompare(req, res, url);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    handleStatic(res, p);
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    res.on('finish', () => log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`));
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });
  return Object.assign(server, {
    idle: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  });
}

export const HOST = '127.0.0.1';
