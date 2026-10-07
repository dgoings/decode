import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAdapters, registerBuiltinAdapters } from '@codeviz/analyzers';
import { compareRefs } from './compare.ts';
import { createServer, type CodevizServer } from './server.ts';

let repo: string;
let cache: string;
const prevCache = process.env.XDG_CACHE_HOME;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const write = (p: string, s: string) => fs.writeFileSync(path.join(repo, p), s);
const moved = Array.from({ length: 8 }, (_, i) => `export function m${i}(x: number) {\n  return x + ${i};\n}\n`).join('');

beforeAll(() => {
  clearAdapters(); // other test files leave throwaway adapters in the shared registry
  registerBuiltinAdapters();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-compare-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-cache-'));
  process.env.XDG_CACHE_HOME = cache;
  git('init', '-q');
  write('a.ts', 'export function a(x: number) {\n  return x;\n}\n');
  write('c.ts', 'export const c = 1;\n');
  write('old.ts', moved);
  git('add', '.');
  git('commit', '-qm', 'one');
  write('c.ts', 'export const c = 2;\n');
  git('commit', '-qam', 'two');
  git('mv', 'old.ts', 'new.ts');
  write(
    'a.ts',
    "import { c } from './c';\nexport function a(x: number) {\n  if (x > c) return x;\n  return c;\n}\n",
  );
  git('commit', '-qam', 'three');
});
afterAll(() => {
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('compareRefs reports renames, code deltas and edges; /api/compare serves the same diff', async () => {
  const d = await compareRefs(repo, 'HEAD~1', 'HEAD', { since: '1y' });
  expect(d.base.sha).toBe(git('rev-parse', 'HEAD~1'));
  expect(d.renames).toEqual({ 'old.ts': 'new.ts' });
  const byPath = new Map(d.files.map((f) => [f.path, f]));
  expect(byPath.get('new.ts')).toMatchObject({ status: 'renamed', oldPath: 'old.ts', code: 0 });
  expect(byPath.has('old.ts')).toBe(false);
  expect(byPath.get('a.ts')).toMatchObject({ status: 'modified', code: 2 });
  expect(d.totals.files).toMatchObject({ added: 0, removed: 0, modified: 1, renamed: 1 });
  expect(d.edges.added.filter((e) => e.level === 'file')).toEqual([{ from: 'a.ts', to: 'c.ts', kind: 'import', level: 'file' }]);
  expect(d.totals.edges.removed).toBe(0);

  await expect(compareRefs(repo, 'WORKTREE', 'HEAD', { since: '1y' })).rejects.toThrow('WORKTREE');

  const server: CodevizServer = createServer({ root: repo, since: '1y' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ok = await fetch(`${base}/api/compare?base=HEAD~1&head=HEAD`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).totals).toEqual(d.totals);
    const bad = await fetch(`${base}/api/compare?base=nope&head=HEAD`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('nope');
  } finally {
    server.close();
    await server.idle();
  }
}, 30_000);
