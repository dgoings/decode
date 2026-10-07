import { expect, test } from 'bun:test';
import { decodeSnapshot, encodeSnapshot, mergeSnapshots, type SnapshotMeta } from './index.ts';

const meta: SnapshotMeta = {
  repo: 'r', repoId: 'root', origin: 'o', sha: 's', ref: 'main', analyzedAt: 't', toolVersion: '0.1.0',
};

test('merge overlapping and disjoint files', () => {
  const s = mergeSnapshots(meta, [
    { languages: { ts: 'baseline' }, files: [{ path: 'a.ts', loc: 10 }, { path: 'b.ts', loc: 5 }] },
    {
      languages: { ts: 'precise' },
      files: [{ path: 'a.ts', loc: 12, churn: { commits: 3, authors: 1 } }, { path: 'c.ts', loc: 1 }],
      modules: [{ id: 'm', kind: 'dir', files: ['a.ts'] }],
    },
    { modules: [{ id: 'm', kind: 'dir', files: [] }] },
  ]);
  expect(s.languages).toEqual({ ts: 'precise' });
  expect(s.files).toEqual([
    { path: 'a.ts', loc: 12, churn: { commits: 3, authors: 1 } },
    { path: 'b.ts', loc: 5 },
    { path: 'c.ts', loc: 1 },
  ]);
  expect(s.modules).toEqual([{ id: 'm', kind: 'dir', files: ['a.ts'] }]);
  expect(s.edges).toEqual([]);
});

test('gzip round trip', () => {
  const s = mergeSnapshots(meta, [
    {
      languages: { ts: 'precise' },
      files: [{ path: 'a.ts', lang: 'ts', loc: 1, complexity: { sum: 1, max: 1, functions: 1 } }],
      edges: [{ from: 'a.ts', to: 'b.ts', kind: 'import', level: 'file' }],
      coupling: [{ a: 'a.ts', b: 'b.ts', coChanges: 2 }],
    },
  ]);
  expect(decodeSnapshot(encodeSnapshot(s))).toEqual(s);
});

test('module files union and edge kind kept', () => {
  const s = mergeSnapshots(meta, [
    { modules: [{ id: 'm', kind: 'dir', files: ['a'] }], edges: [{ from: 'a', to: 'b', kind: 'import', level: 'file' }] },
    { modules: [{ id: 'm', kind: 'package', files: ['a', 'b'] }], edges: [{ from: 'a', to: 'b', kind: 'reexport', level: 'file' }] },
  ]);
  expect(s.modules).toEqual([{ id: 'm', kind: 'package', files: ['a', 'b'] }]);
  expect(s.edges).toHaveLength(2);
});
