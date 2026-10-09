import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultBranch, parseMergeSubject, prRange, recentMerges } from './pr.ts';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const commit = (file: string, text: string) => {
  fs.writeFileSync(path.join(repo, file), text);
  git('add', '.');
  git('commit', '-qm', `${file} ${text}`);
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-pr-'));
  git('init', '-q', '-b', 'main');
  commit('a.txt', 'one');
  git('checkout', '-qb', 'feature');
  commit('b.txt', 'one');
  commit('b.txt', 'two');
  // main moves on after the branch was cut; the PR must not include this commit.
  git('checkout', '-q', 'main');
  commit('a.txt', 'two');
  git('checkout', '-q', 'feature');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

test('default branch falls back to main without a remote', () => {
  expect(defaultBranch(repo)).toBe('main');
});

test('range starts at the merge-base, not the tip of main', () => {
  const r = prRange(repo);
  expect(r.baseRef).toBe('main');
  expect(r.base).toBe(git('merge-base', 'main', 'feature'));
  expect(r.base).not.toBe(git('rev-parse', 'main'));
  expect(r.head).toBe(git('rev-parse', 'feature'));
  expect(r.commits).toBe(2);
});

test('explicit head and base; on the base itself there is nothing to review', () => {
  expect(prRange(repo, 'main').commits).toBe(0);
  expect(prRange(repo, 'main', 'feature').commits).toBe(1);
});

test('readable errors', () => {
  expect(() => prRange(repo, 'nope')).toThrow(/Unknown git ref: nope/);
  expect(() => prRange(repo, 'HEAD', 'nope')).toThrow(/Unknown git ref: nope/);
});

test('an already-merged, deleted branch is compared with main from just before its merge', () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'done');
  commit('c.txt', 'one');
  const tip = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge done', 'done');
  const merge = git('rev-parse', 'HEAD');
  git('branch', '-qD', 'done');
  commit('a.txt', 'three'); // main keeps moving after the merge

  const r = prRange(repo, tip);
  expect(r.mergedIn).toBe(merge);
  expect(r.base).toBe(git('rev-parse', `${merge}^1`));
  expect(r.head).toBe(tip);
  expect(r.commits).toBe(1);
  // A commit made on main directly is not "merged in": still nothing to review.
  const onMain = git('rev-parse', 'HEAD~1');
  expect(prRange(repo, `${onMain}^1`).mergedIn).toBeUndefined();
  expect(prRange(repo, 'main').commits).toBe(0);
  git('checkout', '-q', 'feature');
});

test('recent merges list deleted branches with where they left main', () => {
  // Built by the previous test: branch "done" merged into main, then deleted.
  const [m] = recentMerges(repo, 'main');
  expect(m!.name).toBe('done');
  expect(m!.head).toBe(git('rev-parse', `${m!.merge}^2`));
  expect(m!.base).toBe(git('merge-base', `${m!.merge}^1`, `${m!.merge}^2`));
  expect(m!.commits).toBe(1);
});

test('merge subjects', () => {
  expect(parseMergeSubject('Merge pull request #42 from acme/fix-login')).toEqual({ name: 'fix-login', pr: 42 });
  expect(parseMergeSubject("Merge branch 'feature/x' into main")).toEqual({ name: 'feature/x' });
  expect(parseMergeSubject("Merge remote-tracking branch 'origin/hotfix'")).toEqual({ name: 'hotfix' });
  expect(parseMergeSubject('Merge story/m10-view')).toEqual({ name: 'story/m10-view' });
  expect(parseMergeSubject('Something else entirely')).toEqual({ name: 'Something else entirely' });
});

test('squash merges: listed from their "(#n)" subject, and reviewed as that one commit', () => {
  git('checkout', '-q', 'main');
  const before = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'd.txt'), 'squashed work');
  git('add', '.');
  git('commit', '-qm', 'Add the d file (#7)');
  const squash = git('rev-parse', 'HEAD');
  commit('a.txt', 'four'); // main moves on

  const [m] = recentMerges(repo, 'main');
  expect(m).toMatchObject({ kind: 'squash', merge: squash, head: squash, base: before, name: 'Add the d file', pr: 7, commits: 1 });
  expect(recentMerges(repo, 'main').some((x) => x.kind === 'merge' && x.name === 'done')).toBe(true);

  const r = prRange(repo, squash);
  expect(r).toMatchObject({ base: before, head: squash, commits: 1, single: true });
  expect(r.mergedIn).toBeUndefined();
  // The tip of main itself is still "nothing to review".
  expect(prRange(repo, 'main').commits).toBe(0);
  git('checkout', '-q', 'feature');
});
