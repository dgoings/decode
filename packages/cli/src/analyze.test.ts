import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAdapters } from '@codeviz/analyzers';
import { analyzeRef } from './analyze.ts';
import { cacheDir } from './cache.ts';
import { repoId } from './repo.ts';

let repo: string;
let cache: string;
const prevCache = process.env.XDG_CACHE_HOME;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const cacheFiles = () => {
  try {
    return fs.readdirSync(cacheDir(repoId(repo))).sort();
  } catch {
    return [];
  }
};

beforeAll(() => {
  clearAdapters(); // other test files register throwaway adapters in the shared registry
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-analyze-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-cache-'));
  process.env.XDG_CACHE_HOME = cache;
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export function f(x: number) {\n  return x > 1 ? 1 : 0;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.appendFileSync(path.join(repo, 'a.ts'), 'export function g() {\n  if (Math.random()) return 1;\n  return 2;\n}\n');
  git('commit', '-qam', 'two');
});
afterAll(() => {
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('analyzeRef: HEAD is analyzed and cached, re-run hits the cache, WORKTREE is never cached', async () => {
  const first = await analyzeRef(repo, 'HEAD', { since: '1y' });
  expect(first.cached).toBe(false);
  const s = first.snapshot;
  expect(s.sha).toBe(git('rev-parse', 'HEAD'));
  expect(s.languages).toEqual({ ts: 'baseline' });
  const a = s.files.find((f) => f.path === 'a.ts')!;
  expect(a.lang).toBe('ts');
  expect(a.churn).toEqual({ commits: 2, authors: 1 });
  expect(s.functions.map((f) => f.name).sort()).toEqual(['f', 'g']);
  expect(cacheFiles()).toEqual([`${s.sha}.json.gz`]);

  const second = await analyzeRef(repo, 'HEAD', { since: '1y' });
  expect(second.cached).toBe(true);
  expect(second.snapshot).toEqual(s);

  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const h = () => 1;\n');
  const wt = await analyzeRef(repo, 'WORKTREE', { since: '1y' });
  expect(wt.cached).toBe(false);
  expect(wt.snapshot.sha).toBe('WORKTREE');
  expect(wt.snapshot.functions.map((f) => f.name)).toEqual(['h']);
  expect(cacheFiles()).toEqual([`${s.sha}.json.gz`]);

  // Dirty HEAD analyzes the committed tree, not the edited file.
  const dirty = await analyzeRef(repo, 'HEAD', { since: '1y', force: true });
  expect(dirty.snapshot.functions.map((f) => f.name).sort()).toEqual(['f', 'g']);
  git('checkout', '--', 'a.ts');
  expect(git('worktree', 'list').split('\n')).toHaveLength(1);
});

test('bundled node CLI analyzes the repo and emits JSON', () => {
  const root = path.resolve(import.meta.dir, '../../..');
  const out = path.join(cache, 'cli.js');
  execFileSync('bun', ['build', 'packages/cli/src/cli.ts', '--target=node', `--outfile=${out}`,
    '--external', 'web-tree-sitter', '--external', 'tree-sitter-wasms'], { cwd: root, stdio: 'ignore' });
  // Externals resolve from the repo's node_modules.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(cache, 'node_modules'));
  const json = execFileSync('node', [out, 'analyze', 'WORKTREE', '--json'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = JSON.parse(json);
  expect(s.sha).toBe('WORKTREE');
  expect(s.functions.length).toBe(2);
  let code = 0;
  try {
    execFileSync('node', [out, 'analyze', 'nope'], { cwd: repo, stdio: 'pipe' });
  } catch (err) {
    code = (err as { status: number }).status;
  }
  expect(code).toBe(1);
}, 30000);
