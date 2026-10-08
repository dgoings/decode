import { expect, test } from 'bun:test';
import type { FileDelta, SnapshotDiff } from '@codeviz/core';
import { deltaFiles, sliceFor } from './model.ts';

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

test('sliceFor: net growth over head code, shrink over base code, full width for added/removed', () => {
  const f = (code: number) => ({ path: 'x.ts', code });
  expect(sliceFor(d('x.ts', 'modified', 6, { head: { path: 'x.ts', code: 10 } }), f(10))).toEqual({ kind: 'grow', frac: 0.6 });
  expect(sliceFor(d('x.ts', 'modified', -5, { base: { path: 'x.ts', code: 20 } }), f(15))).toEqual({ kind: 'shrink', frac: 0.25 });
  // Without base/head entries the sizes fall back to the drawn file (+ the delta for base).
  expect(sliceFor(d('x.ts', 'modified', -5), f(15))).toEqual({ kind: 'shrink', frac: 0.25 });
  expect(sliceFor(d('x.ts', 'added', 12), f(12))).toEqual({ kind: 'added', frac: 1 });
  expect(sliceFor(d('x.ts', 'removed', -30), f(30))).toEqual({ kind: 'removed', frac: 1 });
  expect(sliceFor(d('x.ts', 'renamed', 0, { oldPath: 'y.ts' }), f(8))).toBeNull();
  expect(sliceFor(d('x.ts', 'modified', 0, { complexitySum: 3 }), f(8))).toBeNull();
  expect(sliceFor(d('x.ts', 'unchanged', 0), f(8))).toBeNull();
  expect(sliceFor(undefined, f(8))).toBeNull();
  // Zero sizes are guarded (full width rather than Infinity/NaN).
  expect(sliceFor(d('x.ts', 'modified', 3, { head: { path: 'x.ts', code: 0 } }), f(0))).toEqual({ kind: 'grow', frac: 1 });
});
