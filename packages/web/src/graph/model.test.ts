import { expect, test } from 'bun:test';
import type { Snapshot } from '@codeviz/core';
import { aggregateEdges, buildGraphModel, cyclePath, edgeKey, findCycles, groupsBelow } from './model.ts';

const e = (from: string, to: string) => ({ from, to, kind: 'import', level: 'file' as const });

const snap = {
  files: [
    { path: 'src/a/x.ts', code: 10, complexity: { sum: 3, max: 2, functions: 2 }, churn: { commits: 4, authors: 1 } },
    { path: 'src/a/y.ts', code: 5 },
    { path: 'src/b/z.ts', code: 7 },
    { path: 'src/b/w.ts', code: 1 },
    { path: 'lib/u.ts', code: 2 },
    { path: 'lib/v.ts', code: 3 },
  ],
  // 'src' is skipped on purpose: it must be created as an intermediate group.
  modules: [
    { id: 'src/a', kind: 'dir', files: ['src/a/x.ts', 'src/a/y.ts'] },
    { id: 'src/b', kind: 'dir', files: ['src/b/z.ts', 'src/b/w.ts'] },
    { id: 'lib', kind: 'dir', files: ['lib/u.ts', 'lib/v.ts'] },
  ],
  edges: [
    // 3-cycle x -> y -> z -> x (crosses src/a and src/b)
    e('src/a/x.ts', 'src/a/y.ts'),
    e('src/a/y.ts', 'src/b/z.ts'),
    e('src/b/z.ts', 'src/a/x.ts'),
    e('src/b/z.ts', 'src/b/w.ts'),
    e('src/b/w.ts', 'lib/u.ts'),
    e('src/a/x.ts', 'lib/v.ts'),
    e('lib/u.ts', 'lib/v.ts'),
    e('lib/u.ts', 'lib/v.ts'), // duplicate: deduped
  ],
} as unknown as Snapshot;

test('buildGraphModel nests files under dir groups and creates skipped intermediate dirs', () => {
  const m = buildGraphModel(snap);
  const parent = (id: string) => m.nodes.get(id)?.parent;
  expect(parent('src/a/x.ts')).toBe('src/a');
  expect(parent('src/b/w.ts')).toBe('src/b');
  expect(parent('lib/u.ts')).toBe('lib');
  expect(parent('src/a')).toBe('src');
  expect(parent('src')).toBeNull();
  expect(m.nodes.get('src')!.type).toBe('group');
  expect(m.nodes.get('src')!.fileCount).toBe(4);
  expect(m.nodes.get('src/a/x.ts')!.metrics).toEqual({ code: 10, complexityMax: 2, churnCommits: 4 });
  expect(m.edges.length).toBe(7);
  expect([...groupsBelow(m, 1)].sort()).toEqual(['src/a', 'src/b']);
});

test('aggregateEdges re-targets edges to the collapsed group, merges counts, drops self-loops', () => {
  const m = buildGraphModel(snap);
  const cycles = findCycles(m);
  const v = aggregateEdges(m, new Set(['src/b']), cycles);
  expect(v.nodes.map((n) => n.id)).not.toContain('src/b/z.ts');
  expect(v.nodes.find((n) => n.id === 'src/b')!.collapsed).toBe(true);
  const edges = Object.fromEntries(v.edges.map((x) => [`${x.from} > ${x.to}`, [x.count, x.cycleCount]]));
  expect(edges).toEqual({
    'src/a/x.ts > src/a/y.ts': [1, 1],
    'src/a/y.ts > src/b': [1, 1],
    'src/b > src/a/x.ts': [1, 1],
    'src/b > lib/u.ts': [1, 0], // z -> w is internal to src/b and dropped
    'src/a/x.ts > lib/v.ts': [1, 0],
    'lib/u.ts > lib/v.ts': [1, 0],
  });
  // Collapsing src hides src/a and src/b; the whole cycle folds into one node.
  const top = aggregateEdges(m, new Set(['src', 'src/b']));
  expect(top.repOf('src/b/z.ts')).toBe('src');
  expect(top.edges.map((x) => [x.from, x.to, x.count])).toEqual([
    ['src', 'lib/u.ts', 1],
    ['src', 'lib/v.ts', 1],
    ['lib/u.ts', 'lib/v.ts', 1],
  ]);
});

test('findCycles finds the 3-cycle and its edges', () => {
  const m = buildGraphModel(snap);
  const c = findCycles(m);
  expect(c.components).toEqual([['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts']]);
  expect([...c.edgeKeys].sort()).toEqual(
    [edgeKey('src/a/x.ts', 'src/a/y.ts'), edgeKey('src/a/y.ts', 'src/b/z.ts'), edgeKey('src/b/z.ts', 'src/a/x.ts')].sort(),
  );
  expect(cyclePath(m, c.components[0]!)).toEqual(['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts']);
});

test('empty snapshot does not throw', () => {
  const m = buildGraphModel({ files: [], modules: [], edges: [] } as unknown as Snapshot);
  expect(m.nodes.size).toBe(0);
  expect(findCycles(m).components).toEqual([]);
  expect(aggregateEdges(m, new Set()).edges).toEqual([]);
});
