import { expect, test } from 'bun:test';
import { findAnalyzed } from './refpicker.ts';
import { WORKTREE, type SnapshotIndex } from './data.ts';

const sha = (c: string) => c.repeat(40);

const index: SnapshotIndex = {
  repo: 'r',
  repoId: 'id',
  head: sha('a'),
  snapshots: [
    { sha: sha('a'), ref: 'main', analyzedAt: '', toolVersion: '', languages: {} },
    { sha: sha('b'), ref: 'v1', analyzedAt: '', toolVersion: '', languages: {} },
  ],
  refs: [
    { name: 'main', sha: sha('a'), kind: 'branch' },
    { name: 'topic', sha: sha('c'), kind: 'branch' },
    { name: 'v1', sha: sha('b'), kind: 'tag' },
  ],
  worktree: null,
};

test('a branch or tag at an analyzed sha resolves without analysis', () => {
  expect(findAnalyzed(index, 'main')).toBe(sha('a'));
  expect(findAnalyzed(index, 'v1')).toBe(sha('b'));
});

test('a named ref with no snapshot needs analysis', () => {
  expect(findAnalyzed(index, 'topic')).toBeNull();
});

test('a full sha or an unambiguous prefix resolves, case-insensitively', () => {
  expect(findAnalyzed(index, sha('a'))).toBe(sha('a'));
  expect(findAnalyzed(index, 'bbbb')).toBe(sha('b'));
  expect(findAnalyzed(index, 'AAAAAAA')).toBe(sha('a'));
});

test('an ambiguous prefix, a short prefix and a revision expression need analysis', () => {
  const two: SnapshotIndex = {
    ...index,
    snapshots: [
      { sha: `aa${'0'.repeat(38)}`, ref: 'x', analyzedAt: '', toolVersion: '', languages: {} },
      { sha: `aa${'1'.repeat(38)}`, ref: 'y', analyzedAt: '', toolVersion: '', languages: {} },
    ],
  };
  expect(findAnalyzed(two, 'aa0')).toBeNull(); // under four characters
  expect(findAnalyzed(two, 'aaaa')).toBeNull(); // matches neither
  expect(findAnalyzed(two, 'aa00')).toBe(`aa${'0'.repeat(38)}`);
  expect(findAnalyzed(index, 'HEAD~50')).toBeNull();
  expect(findAnalyzed(index, 'HEAD')).toBeNull();
});

test('WORKTREE resolves only once it is analyzed', () => {
  expect(findAnalyzed(index, WORKTREE)).toBeNull();
  expect(findAnalyzed({ ...index, worktree: { analyzedAt: '' } }, WORKTREE)).toBe(WORKTREE);
});
