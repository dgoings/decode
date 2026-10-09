import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '@codeviz/core';
import { cacheDir, type SnapshotSummary } from './cache.ts';
import { compareRefs } from './compare.ts';
import { summarize, type Overlay } from './overlay.ts';
import { defaultBranch, prRange, recentMerges, type PrRange } from './pr.ts';
import { resolveRef } from './refs.ts';
import { TraceStore } from './trace/live.ts';
import { repoId, repoName } from './repo.ts';
import { analyzeInChild, type ChildAnalysis } from './worker.ts';

export interface ServerOptions {
  root: string;
  since: string;
  log?: (s: string) => void;
  /** Seed the in-memory WORKTREE snapshot (e.g. from `codeviz compare HEAD WORKTREE --open`). */
  worktree?: Snapshot | null;
  /** From `--overlay`: served at /api/overlays, never cached. */
  overlays?: Overlay[];
  /** From `--trace`: recorded traces served at /api/traces (in memory only). Live ones are added here too. */
  traces?: TraceStore;
  /** `--trace-listen`: accept live ticks (POST /trace, the Bun preload's body shape) on this server. */
  traceListen?: boolean;
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
export function findWebDir(): string | null {
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

/** Async git, so the two calls behind GET /api/snapshots run in parallel and off the event loop. */
function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out.trim()),
    ),
  );
}

async function listRefs(root: string): Promise<{ name: string; sha: string; kind: 'branch' | 'tag' }[]> {
  // %(*objectname) is the peeled commit for annotated tags.
  const out = await gitAsync(root, [
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

/** Paths that take live trace ticks on the serve port (`--trace-listen`). */
export const TRACE_POST_PATHS = new Set(['/trace', '/api/traces']);

/**
 * POST handler for live ticks (NDJSON: header line + ticks, as harness/bun-trace.ts posts them).
 * Requests from a web page on another origin are refused, so a page open in the browser cannot
 * inject ticks; the preload (no Origin header) and same-origin posts are accepted.
 */
export async function handleTracePost(store: TraceStore, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'cross-origin trace post' });
  try {
    const { accepted, dropped } = store.accept(await readBody(req));
    if (accepted === 0) return sendJson(res, 400, { error: 'no valid tick (each post needs a valid header line and ticks)', dropped });
    res.writeHead(204).end();
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
}

/** Server-Sent Events: ticks of live trace `id` from index `from`, then each new one as it arrives. */
function handleTraceStream(store: TraceStore, req: http.IncomingMessage, res: http.ServerResponse, id: string, from: number): void {
  const trace = store.get(id);
  if (!trace) return sendJson(res, 404, { error: 'no such trace' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': codeviz trace stream\n\n');
  const send = (tick: unknown) => res.write(`data: ${JSON.stringify(tick)}\n\n`);
  for (const tick of trace.ticks.slice(Math.max(0, from))) send(tick);
  if (!store.isLive(id)) return void res.end();
  const off = store.subscribe(id, (tick) => send(tick));
  const ka = setInterval(() => res.write(': ka\n\n'), 15_000);
  req.on('close', () => {
    off();
    clearInterval(ka);
  });
}

export type CodevizServer = http.Server & {
  /** Resolves once no analysis is in flight (so temp worktrees have been cleaned up). */
  idle(): Promise<void>;
  /** Send SIGINT to every running analysis child so each removes its temp worktree and exits. */
  interrupt(): void;
};

export function createServer(opts: ServerOptions): CodevizServer {
  const log = opts.log ?? (() => {});
  const root = git(opts.root, ['rev-parse', '--show-toplevel']);
  const id = repoId(root);
  const name = repoName(root);
  const webDir = findWebDir();
  let worktree: Snapshot | null = opts.worktree ?? null;
  const overlays = opts.overlays ?? [];
  const overlayGz = new Map(overlays.map((o) => [o.name, gzipSync(JSON.stringify(o))]));
  const traces = opts.traces ?? new TraceStore();
  /**
   * Like cache.listSnapshots, but each file is decoded only once per (mtime, size): decoding every
   * cached snapshot on each GET /api/snapshots costs tens of ms with a dozen snapshots cached.
   */
  const summaries = new Map<string, { key: string; summary: SnapshotSummary | null }>();
  function listSnapshots(): SnapshotSummary[] {
    const dir = cacheDir(id);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json.gz'));
    } catch {
      return [];
    }
    for (const n of summaries.keys()) if (!names.includes(n)) summaries.delete(n);
    const out: SnapshotSummary[] = [];
    for (const n of names) {
      let entry = summaries.get(n);
      try {
        const st = statSync(path.join(dir, n));
        const key = `${st.mtimeMs}:${st.size}`;
        if (entry?.key !== key) {
          let summary: SnapshotSummary | null = null;
          try {
            const s = decodeSnapshot(readFileSync(path.join(dir, n)));
            summary = { sha: s.sha, ref: s.ref, analyzedAt: s.analyzedAt, toolVersion: s.toolVersion, languages: s.languages };
          } catch {
            // corrupt or half-written: skipped until it changes
          }
          entry = { key, summary };
          summaries.set(n, entry);
        }
      } catch {
        continue; // removed meanwhile
      }
      if (entry.summary) out.push(entry.summary);
    }
    return out;
  }

  /** Running analysis children by ref; one per ref, shared by /api/analyze and /api/compare. */
  const inFlight = new Map<string, ChildAnalysis>();
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

  /** Analyze `ref` in a child process (off this event loop), joining a run already in flight for it. */
  function analyze(ref: string, force = false): Promise<{ snapshot: Snapshot; cached: boolean }> {
    const existing = inFlight.get(ref);
    if (existing) return existing.result;
    const job = analyzeInChild(root, ref, { since: opts.since, force, log });
    inFlight.set(ref, job);
    const done = job.result.then((r) => {
      if (r.snapshot.sha === 'WORKTREE') worktree = r.snapshot;
      return r;
    });
    done.then(
      () => inFlight.delete(ref),
      () => inFlight.delete(ref),
    );
    return track(done);
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
    try {
      resolveRef(root, ref);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const { snapshot, cached } = await analyze(ref, body.force === true);
      sendJson(res, 200, { sha: snapshot.sha, ref, cached });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
      // Analyze both sides in children first so compareRefs only reads cache hits (and the in-memory WORKTREE).
      await Promise.all([analyze(base), head === 'WORKTREE' && worktree ? null : analyze(head)]);
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const diff = await track(compareRefs(root, base, head, { since: opts.since, log, worktree }));
      sendGzippedJson(req, res, gzipSync(JSON.stringify(diff)));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** What a PR from `head` would show: the same range `codeviz pr` reviews (merged branches included). */
  function handlePr(res: http.ServerResponse, url: URL): void {
    const head = url.searchParams.get('head')?.trim();
    const base = url.searchParams.get('base')?.trim() || undefined;
    if (!head) return sendJson(res, 400, { error: 'head is required' });
    let range: PrRange;
    try {
      range = prRange(root, head, base);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    if (range.commits === 0) {
      return sendJson(res, 400, { error: `${head} has no commits that ${range.baseRef} does not already have` });
    }
    sendJson(res, 200, range);
  }

  /** Branches merged into the default branch, newest first (deleted ones included). */
  function handleMerges(res: http.ServerResponse, url: URL): void {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    const baseRef = defaultBranch(root);
    if (!baseRef) return sendJson(res, 200, { baseRef: null, merges: [] });
    try {
      sendJson(res, 200, { baseRef, merges: recentMerges(root, baseRef, limit) });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
      const [head, refs] = await Promise.all([gitAsync(root, ['rev-parse', 'HEAD']), listRefs(root)]);
      return sendJson(res, 200, {
        repo: name,
        repoId: id,
        head,
        snapshots: listSnapshots(),
        refs,
        worktree: worktree ? { analyzedAt: worktree.analyzedAt } : null,
      });
    }
    const m = /^\/api\/snapshots\/([^/]+)$/.exec(p);
    if (m && method === 'GET') return handleSnapshot(req, res, m[1]!);
    if (p === '/api/overlays' && method === 'GET') return sendJson(res, 200, overlays.map(summarize));
    const o = /^\/api\/overlays\/([^/]+)$/.exec(p);
    if (o && method === 'GET') {
      const gz = overlayGz.get(decodeURIComponent(o[1]!));
      return gz ? sendGzippedJson(req, res, gz) : sendJson(res, 404, { error: 'no such overlay' });
    }
    if (opts.traceListen && method === 'POST' && TRACE_POST_PATHS.has(p)) return handleTracePost(traces, req, res);
    if (p === '/api/traces' && method === 'GET') return sendJson(res, 200, traces.list());
    const tr = /^\/api\/traces\/([^/]+)(\/stream)?$/.exec(p);
    if (tr && method === 'GET') {
      const tid = decodeURIComponent(tr[1]!);
      if (tr[2]) return handleTraceStream(traces, req, res, tid, Number(url.searchParams.get('from')) || 0);
      const gz = traces.gz(tid);
      return gz ? sendGzippedJson(req, res, gz) : sendJson(res, 404, { error: 'no such trace' });
    }
    if (p === '/api/analyze' && method === 'POST') return handleAnalyze(req, res);
    if (p === '/api/compare' && method === 'GET') return handleCompare(req, res, url);
    if (p === '/api/pr' && method === 'GET') return handlePr(res, url);
    if (p === '/api/merges' && method === 'GET') return handleMerges(res, url);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    handleStatic(res, p);
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    // Live tick posts arrive every tick and the UI polls the trace list; logging those would drown the log.
    if (!(TRACE_POST_PATHS.has(req.url ?? '') && (req.method === 'POST' || req.method === 'GET')))
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
    interrupt: () => {
      for (const { child } of inFlight.values()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
    },
  });
}

export const HOST = '127.0.0.1';
