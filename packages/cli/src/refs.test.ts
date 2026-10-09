import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refName, resolveRef, withCheckout } from './refs.ts';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-test-'));
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
  git('add', '.');
  git('commit', '-qm', 'one');
  git('tag', 'v1');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two');
  git('commit', '-qam', 'two');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

test('HEAD, WORKTREE, unknown', () => {
  expect(resolveRef(repo, 'HEAD').kind).toBe('head');
  expect(resolveRef(repo, 'WORKTREE')).toEqual({ sha: 'WORKTREE', ref: 'WORKTREE', kind: 'worktree' });
  expect(() => resolveRef(repo, 'nope')).toThrow(/Unknown git ref/);
});

test('a ref starting with a dash is rejected, not passed to git as an option', () => {
  expect(() => resolveRef(repo, '--help')).toThrow(/Invalid git ref/);
  expect(() => resolveRef(repo, '-v1')).toThrow(/Invalid git ref/);
});

test('tag is detached, checkout shows old tree and is cleaned up even on reject', async () => {
  const r = resolveRef(repo, 'v1');
  expect(r.kind).toBe('detached');
  expect(r.sha).toBe(git('rev-parse', 'v1'));
  let seen = '';
  await withCheckout(repo, r, async (dir) => {
    seen = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
  });
  expect(seen).toBe('one');

  let dir2 = '';
  await expect(
    withCheckout(repo, r, async (dir) => {
      dir2 = dir;
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(fs.existsSync(dir2)).toBe(false);
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});

test('head and worktree use root', async () => {
  expect(await withCheckout(repo, resolveRef(repo, 'HEAD'), async (d) => d)).toBe(repo);
  expect(await withCheckout(repo, resolveRef(repo, 'WORKTREE'), async (d) => d)).toBe(repo);
});

test('refName: branch for HEAD, tag as given, short sha otherwise', () => {
  const v1 = git('rev-parse', 'v1');
  expect([refName(repo, 'HEAD', git('rev-parse', 'HEAD')), refName(repo, 'v1', v1), refName(repo, v1, v1)])
    .toEqual(['main', 'v1', v1.slice(0, 12)]);
});
