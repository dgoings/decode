import { expect, test } from 'bun:test';
import type { Snapshot, SnapshotDiff } from '@codeviz/core';
import { filterDiff, filterSnapshot, hiddenEntry, isHidden } from './hidden.ts';

const snap: Snapshot = {
  repo: 'r',
  repoId: 'id',
  origin: '',
  sha: 's',
  ref: 'main',
  analyzedAt: '',
  toolVersion: '',
  languages: {},
  files: [{ path: 'CHANGELOG.md', code: 10 }, { path: 'src/a.ts', code: 5 }, { path: 'docs/x.md', code: 1 }],
  functions: [
    { file: 'src/a.ts', name: 'f', line: 1, complexity: 1 },
    { file: 'docs/x.md', name: 'g', line: 1, complexity: 1 },
  ],
  modules: [
    { id: 'src', kind: 'dir', files: ['src/a.ts'] },
    { id: 'docs', kind: 'dir', files: ['docs/x.md'] },
  ],
  edges: [
    { from: 'src/a.ts', to: 'docs/x.md', kind: 'import', level: 'file' },
    { from: 'src/a.ts', to: 'CHANGELOG.md', kind: 'import', level: 'file' },
    { from: 'src', to: 'docs', kind: 'import', level: 'module' },
  ],
  coupling: [{ a: 'src/a.ts', b: 'docs/x.md', coChanges: 2 }],
};

test('filterSnapshot drops hidden files, their functions, emptied modules, and touching edges', () => {
  const out = filterSnapshot(snap, new Set(['docs/x.md', 'CHANGELOG.md']));
  expect(out.files.map((f) => f.path)).toEqual(['src/a.ts']);
  expect(out.functions.map((f) => f.name)).toEqual(['f']);
  expect(out.modules.map((m) => m.id)).toEqual(['src']);
  expect(out.edges).toEqual([]);
  expect(out.coupling).toEqual([]);
  expect(filterSnapshot(snap, new Set())).toBe(snap);
});

test('filterDiff drops hidden deltas and edges and recomputes totals', () => {
  const diff: SnapshotDiff = {
    base: { sha: 'b', ref: 'b' },
    head: { sha: 'h', ref: 'h' },
    renames: {},
    files: [
      { path: 'CHANGELOG.md', status: 'modified', code: 40, loc: 50, comments: 0, complexitySum: 0, complexityMax: 0, churnCommits: 1 },
      { path: 'src/a.ts', status: 'added', code: 5, loc: 6, comments: 0, complexitySum: 1, complexityMax: 1, churnCommits: 1 },
      { path: 'src/b.ts', status: 'unchanged', code: 0, loc: 0, comments: 0, complexitySum: 0, complexityMax: 0, churnCommits: 0 },
    ],
    functions: [{ file: 'CHANGELOG.md', name: 'x', status: 'added', complexity: 1 }],
    edges: {
      added: [{ from: 'src/a.ts', to: 'CHANGELOG.md', kind: 'import', level: 'file' }, { from: 'src/a.ts', to: 'src/b.ts', kind: 'import', level: 'file' }],
      removed: [{ from: 'CHANGELOG.md', to: 'src/b.ts', kind: 'import', level: 'file' }],
    },
    totals: {
      code: 45,
      loc: 56,
      files: { added: 1, removed: 0, modified: 1, renamed: 0, unchanged: 1 },
      edges: { added: 2, removed: 1 },
    },
  };
  const out = filterDiff(diff, new Set(['CHANGELOG.md']));
  expect(out.files.map((d) => d.path)).toEqual(['src/a.ts', 'src/b.ts']);
  expect(out.functions).toEqual([]);
  expect(out.edges.added).toHaveLength(1);
  expect(out.edges.removed).toHaveLength(0);
  expect(out.totals).toEqual({
    code: 5,
    loc: 6,
    files: { added: 1, removed: 0, modified: 0, renamed: 0, unchanged: 1 },
    edges: { added: 1, removed: 0 },
  });
});

test('folder entries hide by path prefix, nested, without catching sibling folders that share a name prefix', () => {
  const hidden = new Set([hiddenEntry({ kind: 'dir', path: 'internal/web' }), 'cmd/main.go']);
  expect([...hidden]).toEqual(['internal/web/', 'cmd/main.go']);
  expect(isHidden('internal/web/a.go', hidden)).toBe(true);
  expect(isHidden('internal/web/sub/deep/b.go', hidden)).toBe(true);
  expect(isHidden('internal/web', hidden)).toBe(true); // the dir/module id itself
  expect(isHidden('internal/webui/c.go', hidden)).toBe(false);
  expect(isHidden('internal/webui', hidden)).toBe(false);
  expect(isHidden('internal/x.go', hidden)).toBe(false);
  expect(isHidden('cmd/main.go', hidden)).toBe(true);
  expect(isHidden('cmd/main.go.bak', hidden)).toBe(false);

  const tree: Snapshot = {
    ...snap,
    files: [{ path: 'internal/web/a.go', code: 1 }, { path: 'internal/webui/c.go', code: 2 }, { path: 'internal/x.go', code: 3 }],
    functions: [],
    modules: [
      { id: 'internal', kind: 'dir', files: ['internal/x.go'] },
      { id: 'internal/web', kind: 'dir', files: ['internal/web/a.go'] },
      { id: 'internal/webui', kind: 'dir', files: ['internal/webui/c.go'] },
    ],
    edges: [
      { from: 'internal/webui/c.go', to: 'internal/web/a.go', kind: 'import', level: 'file' },
      { from: 'internal/webui/c.go', to: 'internal/x.go', kind: 'import', level: 'file' },
    ],
    coupling: [],
  };
  const one = filterSnapshot(tree, new Set(['internal/web/']));
  expect(one.files.map((f) => f.path)).toEqual(['internal/webui/c.go', 'internal/x.go']);
  expect(one.modules.map((m) => m.id)).toEqual(['internal', 'internal/webui']);
  expect(one.edges).toHaveLength(1);
  // A parent folder hides the nested one too; a file entry under it stays independent.
  const all = filterSnapshot(tree, new Set(['internal/', 'internal/web/a.go']));
  expect(all.files).toEqual([]);
  expect(all.modules).toEqual([]);
  expect(all.edges).toEqual([]);
});
