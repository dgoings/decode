import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAdapters, registerBuiltinAdapters } from '@codeviz/analyzers';
import { createServer } from './server.ts';

let repo: string;
let cache: string;
let server: http.Server;
let base: string;
const prevCache = process.env.XDG_CACHE_HOME;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const post = (ref: string) =>
  fetch(`${base}/api/analyze`, { method: 'POST', body: JSON.stringify({ ref }), headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  clearAdapters(); // other test files leave throwaway adapters in the shared registry
  registerBuiltinAdapters();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-serve-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-cache-'));
  process.env.XDG_CACHE_HOME = cache;
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export function f(x: number) {\n  return x > 1 ? 1 : 0;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  server = createServer({ root: repo, since: '1y' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => {
  server.close();
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('analyze, list and fetch snapshots over HTTP', async () => {
  const head = git('rev-parse', 'HEAD');

  const a = await post('HEAD');
  expect(a.status).toBe(200);
  expect(await a.json()).toEqual({ sha: head, ref: 'HEAD', cached: false });

  const idx = await (await fetch(`${base}/api/snapshots`)).json();
  expect(idx.head).toBe(head);
  expect(idx.worktree).toBeNull();
  expect(idx.snapshots.map((s: { sha: string }) => s.sha)).toEqual([head]);
  expect(idx.snapshots[0].languages.ts).toBeDefined();
  expect(idx.refs.some((r: { sha: string; kind: string }) => r.sha === head && r.kind === 'branch')).toBe(true);

  const snap = await fetch(`${base}/api/snapshots/${head}`);
  expect(snap.status).toBe(200);
  expect((await snap.json()).files.map((f: { path: string }) => f.path)).toContain('a.ts');

  const missing = await fetch(`${base}/api/snapshots/deadbeef`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'not analyzed' });

  const bad = await post('nope');
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain('nope');

  expect((await post('WORKTREE')).status).toBe(200);
  const wt = await fetch(`${base}/api/snapshots/WORKTREE`);
  expect(wt.status).toBe(200);
  expect((await wt.json()).sha).toBe('WORKTREE');
  expect((await (await fetch(`${base}/api/snapshots`)).json()).worktree).not.toBeNull();
}, 30_000);

test('analysis runs off the event loop: reads stay responsive and a duplicate POST gets 409', async () => {
  fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
  const first = post('WORKTREE');
  await new Promise((r) => setTimeout(r, 30)); // let the server register the first request
  const t0 = performance.now();
  const list = await fetch(`${base}/api/snapshots`);
  const listMs = performance.now() - t0;
  const dup = await post('WORKTREE'); // still in flight after the read returned
  // The bound is loose because the analysis child competes for CPU; the real-run check uses 50ms.
  expect({ list: list.status, fast: listMs < 250, dup: dup.status, first: (await first).status }).toEqual({
    list: 200,
    fast: true,
    dup: 409,
    first: 200,
  });
}, 30_000);

test('traces: list, fetch, live post and SSE stream', async () => {
  const { TraceStore } = await import('./trace/live.ts');
  const store = new TraceStore();
  const header = { format: 'codeviz-trace' as const, version: 1 as const, sha: 'abc', startedAt: '2026-10-09T16:00:00.000Z', tickMs: 500, source: 'server' as const };
  store.add({ header, ticks: [{ t: 500, files: [['a.ts', 2]], edges: [] }] }, '/x/rec.jsonl.gz');
  const srv = createServer({ root: repo, since: '1y', traces: store, traceListen: true });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    expect((await (await fetch(`${b}/api/traces`)).json())).toEqual([
      { id: 'rec', source: 'server', sha: 'abc', startedAt: header.startedAt, tickMs: 500, ticks: 1, durationMs: 500, live: false },
    ]);
    expect((await (await fetch(`${b}/api/traces/rec`)).json()).ticks).toHaveLength(1);
    const live = { ...header, source: 'browser', startedAt: '2026-10-09T17:00:00.000Z' };
    const tick = { t: 1000, files: [['a.ts', 3]], edges: [] };
    const posted = await fetch(`${b}/trace`, { method: 'POST', body: `${JSON.stringify(live)}\n${JSON.stringify(tick)}\n` });
    expect(posted.status).toBe(204);
    // Malformed ticks: no valid tick -> 400; bad entries inside a tick are dropped, not stored.
    const bad = await fetch(`${b}/trace`, { method: 'POST', body: `${JSON.stringify(live)}\n{"t":100}\n{"t":-1,"files":[]}\n` });
    expect(bad.status).toBe(400);
    const partly = await fetch(`${b}/trace`, { method: 'POST', body: `${JSON.stringify(live)}\n{"t":1500,"files":[5,["a.ts",1]]}\n` });
    expect(partly.status).toBe(204);
    const id = ((await (await fetch(`${b}/api/traces`)).json()) as { id: string; live: boolean }[]).find((t) => t.live)!.id;
    const ctl = new AbortController();
    const stream = await fetch(`${b}/api/traces/${id}/stream?from=0`, { signal: ctl.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    let text = '';
    while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(text.slice(text.indexOf('data: ') + 6).split('\n')[0]!)).toEqual(tick);
    expect(store.get(id)!.ticks.map((tk) => tk.files)).toEqual([[['a.ts', 3]], [['a.ts', 1]]]);
    ctl.abort();
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('pr and merges: a merged, deleted branch is found and its PR range resolved', async () => {
  const main = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('checkout', '-qb', 'gone');
  fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'b');
  const tip = git('rev-parse', 'HEAD');
  git('checkout', '-q', main);
  git('merge', '-q', '--no-ff', '-m', 'Merge gone', 'gone');
  git('branch', '-qD', 'gone');

  const m = await (await fetch(`${base}/api/merges`)).json();
  expect(m.baseRef).toBe(main);
  expect(m.merges[0].name).toBe('gone');
  expect(m.merges[0].head).toBe(tip);

  const pr = await fetch(`${base}/api/pr?head=${tip}`);
  expect(pr.status).toBe(200);
  const range = await pr.json();
  expect(range.head).toBe(tip);
  expect(range.base).toBe(git('rev-parse', 'HEAD^1'));
  expect(range.mergedIn).toBe(git('rev-parse', 'HEAD'));

  const nothing = await fetch(`${base}/api/pr?head=${main}`);
  expect(nothing.status).toBe(400);
  expect((await nothing.json()).error).toMatch(/no commits/);
  expect((await fetch(`${base}/api/pr?head=nope`)).status).toBe(400);
  expect((await fetch(`${base}/api/pr`)).status).toBe(400);
});
