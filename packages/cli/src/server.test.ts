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
