import { expect, test } from 'bun:test';
import type { FileDelta, SnapshotDiff } from '@codeviz/core';
import { changedRows, compareDeltas, deltaFiles } from './model.ts';

const d = (path: string, status: FileDelta['status'], code: number, extra: Partial<FileDelta> = {}): FileDelta => ({
  path,
  status,
  code,
  loc: code,
  comments: 0,
  complexitySum: 0,
  complexityMax: 0,
  churnCommits: 0,
  ...extra,
});

const diff: SnapshotDiff = {
  base: { sha: 'b', ref: 'b' },
  head: { sha: 'h', ref: 'h' },
  renames: { 'src/old.ts': 'src/new.ts' },
  files: [
    d('src/a.ts', 'modified', 5, { complexitySum: -9 }),
    d('src/b.ts', 'unchanged', 0),
    d('src/gone.ts', 'removed', -30, { base: { path: 'src/gone.ts', code: 30, loc: 40 } }),
    d('src/new.ts', 'renamed', 0, { oldPath: 'src/old.ts', complexitySum: 2 }),
    d('src/added.ts', 'added', 12),
  ],
  functions: [],
  edges: { added: [], removed: [] },
  totals: {
    code: -13,
    loc: -13,
    files: { added: 1, removed: 1, modified: 1, renamed: 1, unchanged: 1 },
    edges: { added: 0, removed: 0 },
  },
};

const headFiles = [
  { path: 'src/a.ts', code: 20 },
  { path: 'src/b.ts', code: 10 },
  { path: 'src/new.ts', code: 8 },
  { path: 'src/added.ts', code: 12 },
];

test('deltaFiles keeps head sizes, adds removed files at base size, and filters unchanged', () => {
  const all = deltaFiles(headFiles, diff, false);
  expect(all.map((f) => [f.path, f.code])).toEqual([
    ['src/a.ts', 20],
    ['src/b.ts', 10],
    ['src/new.ts', 8],
    ['src/added.ts', 12],
    ['src/gone.ts', 30],
  ]);
  expect(deltaFiles(headFiles, diff, true).map((f) => f.path)).toEqual([
    'src/a.ts',
    'src/new.ts',
    'src/added.ts',
    'src/gone.ts',
  ]);
});

test('table sort: |code| desc by default, numeric columns by absolute delta, ties by path', () => {
  expect(changedRows(diff).map((r) => r.path)).toEqual(['src/gone.ts', 'src/added.ts', 'src/a.ts', 'src/new.ts']);
  const rows = changedRows(diff);
  expect(rows.sort(compareDeltas({ key: 'complexitySum', desc: true })).map((r) => r.path)).toEqual([
    'src/a.ts',
    'src/new.ts',
    'src/added.ts',
    'src/gone.ts',
  ]);
  expect(rows.sort(compareDeltas({ key: 'code', desc: false }))[0]!.path).toBe('src/new.ts');
  expect(rows.sort(compareDeltas({ key: 'status', desc: false })).map((r) => r.status)).toEqual([
    'added',
    'modified',
    'removed',
    'renamed',
  ]);
});
