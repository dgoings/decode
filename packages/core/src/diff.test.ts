import { expect, test } from 'bun:test';
import { diffSnapshots, parseRenameStatus, type Snapshot } from './index.ts';

function snap(sha: string, parts: Partial<Snapshot>): Snapshot {
  return {
    repo: 'r', repoId: 'id', origin: '', sha, ref: sha, analyzedAt: 't', toolVersion: '0',
    languages: {}, files: [], functions: [], modules: [], edges: [], coupling: [], ...parts,
  };
}

const cx = (sum: number, max: number) => ({ sum, max, functions: 1 });

const base = snap('b1', {
  files: [
    { path: 'gone.ts', code: 5, loc: 6 },
    { path: 'mod.ts', code: 10, loc: 12, complexity: cx(3, 2), churn: { commits: 1, authors: 1 } },
    { path: 'old/moved.ts', code: 7, loc: 7, complexity: cx(1, 1) },
    { path: 'old/grown.ts', code: 4, loc: 4 },
    { path: 'same.ts', code: 2, loc: 2 },
  ],
  functions: [
    { file: 'mod.ts', name: 'f', line: 1, complexity: 2 },
    { file: 'mod.ts', name: 'dropped', line: 5, complexity: 1 },
    { file: 'old/moved.ts', name: 'm', line: 1, complexity: 1 },
  ],
  edges: [
    { from: 'mod.ts', to: 'old/moved.ts', kind: 'import', level: 'file' },
    { from: 'mod.ts', to: 'gone.ts', kind: 'import', level: 'file' },
    { from: 'same.ts', to: 'mod.ts', kind: 'import', level: 'file' },
  ],
});

const head = snap('h1', {
  files: [
    { path: 'mod.ts', code: 15, loc: 18, complexity: cx(5, 3), churn: { commits: 4, authors: 2 } },
    { path: 'new.ts', code: 3, loc: 3 },
    { path: 'new/grown.ts', code: 9, loc: 10 },
    { path: 'new/moved.ts', code: 7, loc: 7, complexity: cx(1, 1) },
    { path: 'same.ts', code: 2, loc: 2 },
  ],
  functions: [
    { file: 'mod.ts', name: 'f', line: 9, complexity: 3 },
    { file: 'new.ts', name: 'fresh', line: 1, complexity: 1 },
    { file: 'new/moved.ts', name: 'm', line: 40, complexity: 1 },
  ],
  edges: [
    { from: 'mod.ts', to: 'new/moved.ts', kind: 'import', level: 'file' },
    { from: 'mod.ts', to: 'new.ts', kind: 'import', level: 'file' },
    { from: 'same.ts', to: 'mod.ts', kind: 'import', level: 'file' },
  ],
});

const renames = { 'old/moved.ts': 'new/moved.ts', 'old/grown.ts': 'new/grown.ts' };

test('file deltas: add, remove, modify, rename, rename-with-change, unchanged', () => {
  const d = diffSnapshots(base, head, renames);
  expect(d.base).toEqual({ sha: 'b1', ref: 'b1' });
  expect(d.files.map((f) => [f.path, f.status, f.oldPath])).toEqual([
    ['gone.ts', 'removed', undefined],
    ['mod.ts', 'modified', undefined],
    ['new.ts', 'added', undefined],
    ['new/grown.ts', 'renamed', 'old/grown.ts'],
    ['new/moved.ts', 'renamed', 'old/moved.ts'],
    ['same.ts', 'unchanged', undefined],
  ]);
  const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
  expect(by['mod.ts']).toMatchObject({ code: 5, loc: 6, complexitySum: 2, complexityMax: 1, churnCommits: 3 });
  expect(by['new/moved.ts']).toMatchObject({ code: 0, loc: 0, comments: 0, complexitySum: 0, complexityMax: 0 });
  expect(by['new/grown.ts']).toMatchObject({ code: 5, loc: 6 });
  expect(by['gone.ts']).toMatchObject({ code: -5, loc: -6, base: { path: 'gone.ts' } });
  expect(by['gone.ts']!.head).toBeUndefined();
  expect(by['new.ts']).toMatchObject({ code: 3, head: { path: 'new.ts' } });
  expect(by['same.ts']!.base).toBeUndefined();
  expect(d.totals).toEqual({
    code: -5 + 5 + 3 + 5,
    loc: -6 + 6 + 3 + 6,
    files: { added: 1, removed: 1, modified: 1, renamed: 2, unchanged: 1 },
    edges: { added: 1, removed: 1 },
  });
});

test('without the rename map a move is a delete plus add', () => {
  const d = diffSnapshots(base, head);
  expect(d.totals.files).toEqual({ added: 3, removed: 3, modified: 1, renamed: 0, unchanged: 1 });
  expect(d.edges.removed).toContainEqual({ from: 'mod.ts', to: 'old/moved.ts', kind: 'import', level: 'file' });
});

test('functions: added, removed, modified; renamed file and line moves ignored', () => {
  const d = diffSnapshots(base, head, renames);
  expect(d.functions).toEqual([
    { file: 'mod.ts', name: 'dropped', status: 'removed', complexity: -1, baseComplexity: 1 },
    { file: 'mod.ts', name: 'f', status: 'modified', complexity: 1, baseComplexity: 2, headComplexity: 3 },
    { file: 'new.ts', name: 'fresh', status: 'added', complexity: 1, headComplexity: 1 },
  ]);
});

test('edges follow renames; added and removed reported', () => {
  const d = diffSnapshots(base, head, renames);
  expect(d.edges).toEqual({
    added: [{ from: 'mod.ts', to: 'new.ts', kind: 'import', level: 'file' }],
    removed: [{ from: 'mod.ts', to: 'gone.ts', kind: 'import', level: 'file' }],
  });
});

test('module-level edges on one side only are distinct keys', () => {
  const b = snap('b', { edges: [{ from: 'pkg/a', to: 'pkg/b', kind: 'import', level: 'module' }] });
  const h = snap('h', {
    edges: [
      { from: 'pkg/a/x.go', to: 'pkg/b/y.go', kind: 'import', level: 'file' },
      { from: 'pkg/a', to: 'pkg/b', kind: 'import', level: 'module' },
      { from: 'pkg/a', to: 'pkg/c', kind: 'import', level: 'module' },
    ],
  });
  const d = diffSnapshots(b, h);
  expect(d.edges.removed).toEqual([]);
  expect(d.edges.added).toEqual([
    { from: 'pkg/a', to: 'pkg/c', kind: 'import', level: 'module' },
    { from: 'pkg/a/x.go', to: 'pkg/b/y.go', kind: 'import', level: 'file' },
  ]);
  const onlyModule = diffSnapshots(h, snap('m', { edges: [{ from: 'pkg/a', to: 'pkg/b', kind: 'import', level: 'module' }] }));
  expect(onlyModule.edges.added).toEqual([]);
  expect(onlyModule.edges.removed.map((e) => e.level)).toEqual(['module', 'file']);
});

test('diffing a snapshot with itself is all unchanged', () => {
  const d = diffSnapshots(head, head);
  expect(d.files.every((f) => f.status === 'unchanged')).toBe(true);
  expect(d.functions).toEqual([]);
  expect(d.totals).toMatchObject({ code: 0, loc: 0, edges: { added: 0, removed: 0 } });
});

test('parseRenameStatus reads -z name-status output', () => {
  const out = [
    'M', 'src/a.ts',
    'R095', 'old dir/file one.ts', 'new dir/file one.ts',
    'A', 'added.ts',
    'C080', 'src/copy-src.ts', 'src/copy-dst.ts',
    'D', 'removed.ts',
    'R100', 'src/ünï.ts', 'lib/ünï.ts',
    '',
  ].join('\0');
  expect(parseRenameStatus(out)).toEqual({
    'old dir/file one.ts': 'new dir/file one.ts',
    'src/ünï.ts': 'lib/ünï.ts',
  });
  expect(parseRenameStatus('')).toEqual({});
});
