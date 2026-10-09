import { expect, test } from 'bun:test';
import type { Snapshot, SnapshotDiff } from '@codeviz/core';
import { aggregateEdges, buildCompareGraphModel, buildGraphModel, cyclePath, edgeKey, findCycles, groupsBelow } from './model.ts';

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

test('buildGraphModel allFiles adds sized files without edges or modules, nesting new dir groups', () => {
  const extra = {
    ...snap,
    files: [...snap.files, { path: 'internal/cli/run.go', code: 40 }, { path: 'internal/db.go', loc: 9 }, { path: 'docs/old.md' }],
  } as Snapshot;
  expect(buildGraphModel(extra).nodes.has('internal/cli/run.go')).toBe(false);
  const m = buildGraphModel(extra, { allFiles: true });
  const parent = (id: string) => m.nodes.get(id)?.parent;
  expect(parent('internal/cli/run.go')).toBe('internal/cli');
  expect(parent('internal/cli')).toBe('internal');
  expect(parent('internal/db.go')).toBe('internal');
  expect(m.nodes.has('docs/old.md')).toBe(false); // no size info
  expect(m.nodes.get('internal')).toMatchObject({ type: 'group', fileCount: 2, code: 40 });
  expect(m.edges.length).toBe(7);
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

// Seam 4: module-level edges and opaque (package) modules. Fixtures are also used by the headless UI check.
import moduleOnlyJson from './fixtures/module-only.json';
import mixedJson from './fixtures/mixed.json';

const moduleOnly = moduleOnlyJson as unknown as Snapshot;
const mixed = mixedJson as unknown as Snapshot;
const P = 'github.com/acme/shop/';

test('module-only snapshot: 6 opaque package leaves, no compounds, no files, 8 module edges, 3-cycle', () => {
  const m = buildGraphModel(moduleOnly);
  const nodes = [...m.nodes.values()];
  expect(nodes.length).toBe(6);
  expect(nodes.every((n) => n.type === 'leaf' && n.kind === 'package' && n.parent === null)).toBe(true);
  expect(groupsBelow(m, 0).size).toBe(0);
  const api = m.nodes.get(`${P}internal/api`)!;
  expect(api.label).toBe('api');
  expect(api.fileCount).toBe(2);
  expect(api.code).toBe(430);
  expect(m.edges.length).toBe(8);
  expect(m.edges.every((e) => e.level === 'module')).toBe(true);
  const c = findCycles(m);
  expect(c.components).toEqual([[`${P}internal/api`, `${P}internal/model`, `${P}internal/store`]]);
  expect(c.edgeKeys.size).toBe(3);
  expect(cyclePath(m, c.components[0]!)).toEqual([`${P}internal/api`, `${P}internal/store`, `${P}internal/model`]);
  const v = aggregateEdges(m, new Set(), c);
  expect(v.nodes.length).toBe(6);
  expect(v.edges.length).toBe(8);
  expect(v.edges.every((e) => e.level === 'module')).toBe(true);
});

test('mixed snapshot: dir tree and package nodes coexist, each edge keeps its level, nothing duplicated', () => {
  const m = buildGraphModel(mixed);
  const G = 'example.com/svc';
  const levels = (lvl: string) => m.edges.filter((e) => e.level === lvl);
  expect(levels('file').length).toBe(5);
  expect(levels('module').length).toBe(3);
  expect(new Set(m.edges.map((e) => e.key)).size).toBe(8);
  // Go files are never nodes and no directories are invented from package ids or Go file paths.
  for (const id of ['svc', 'svc/main.go', 'example.com', 'svc/db']) expect(m.nodes.has(id)).toBe(false);
  expect(m.nodes.get('src/a/x.ts')!.parent).toBe('src/a');
  expect(m.nodes.get('src')!.kind).toBe('dir');
  // Real nesting (example.com/svc contains example.com/svc/db, /http): one package compound.
  const g = m.nodes.get(`${G}/`)!;
  expect(g).toMatchObject({ type: 'group', kind: 'package', parent: null, label: 'svc/', fileCount: 4, code: 425 });
  expect(m.children.get(`${G}/`)!.sort()).toEqual([G, `${G}/db`, `${G}/http`]);
  expect(m.nodes.get(G)).toMatchObject({ type: 'leaf', kind: 'package', label: 'svc', fileCount: 1, code: 90 });
  // Expanded: every model edge is visible once, with its level.
  const v = aggregateEdges(m, new Set(), findCycles(m));
  expect(v.edges.length).toBe(8);
  expect(v.edges.filter((e) => e.level === 'module').map((e) => [e.from, e.to])).toEqual([
    [G, `${G}/http`],
    [`${G}/http`, `${G}/db`],
    [G, `${G}/db`],
  ]);
  // Collapsing the dir tree never swallows module edges, and vice versa.
  const c = aggregateEdges(m, new Set(['src', `${G}/`]));
  expect(c.edges.map((e) => [e.from, e.to, e.level, e.count])).toEqual([
    ['src', 'lib/u.ts', 'file', 1],
    ['src', 'lib/v.ts', 'file', 1],
    ['lib/u.ts', 'lib/v.ts', 'file', 1],
  ]);
  expect(groupsBelow(m, 0)).toEqual(new Set(['src', 'src/a', 'src/b', 'lib', `${G}/`]));
});

test('opaque module ids without real nesting stay flat; unknown module endpoints become opaque leaves', () => {
  const s = {
    files: [],
    modules: [
      { id: 'a/x', kind: 'namespace', files: [] },
      { id: 'a/y', kind: 'namespace', files: [] },
    ],
    edges: [
      { from: 'a/x', to: 'a/y', kind: 'import', level: 'module' },
      { from: 'a/y', to: 'ext/z', kind: 'import', level: 'module' },
    ],
  } as unknown as Snapshot;
  const m = buildGraphModel(s);
  expect([...m.nodes.keys()].sort()).toEqual(['a/x', 'a/y', 'ext/z']);
  expect([...m.nodes.values()].every((n) => n.type === 'leaf' && n.parent === null)).toBe(true);
  expect(m.nodes.get('ext/z')!.kind).toBe('module');
});

test('buildCompareGraphModel marks added edges, adds removed ones with ghost endpoints, and aggregates to mixed', () => {
  const diff = {
    edges: {
      added: [e('src/a/y.ts', 'lib/u.ts')],
      removed: [e('src/a/gone.ts', 'lib/v.ts')],
    },
  } as unknown as SnapshotDiff;
  const head = { ...snap, edges: [...(snap.edges as unknown[]), e('src/a/y.ts', 'lib/u.ts')] } as unknown as Snapshot;
  const m = buildCompareGraphModel(head, diff);
  const change = (from: string, to: string) => m.edges.find((x) => x.key === edgeKey(from, to))?.change;
  expect(change('src/a/y.ts', 'lib/u.ts')).toBe('added');
  expect(change('src/a/gone.ts', 'lib/v.ts')).toBe('removed');
  expect(change('src/a/x.ts', 'lib/v.ts')).toBeUndefined();
  const ghost = m.nodes.get('src/a/gone.ts')!;
  expect(ghost.ghost).toBe(true);
  expect(ghost.parent).toBe('src/a');
  expect(ghost.depth).toBe(2);
  expect(m.children.get('src/a')).toContain('src/a/gone.ts');

  // Collapsing src/a and lib merges both changed edges (and the unchanged x -> v) into one.
  const v = aggregateEdges(m, new Set(['src/a', 'lib']));
  const agg = v.edges.find((x) => x.from === 'src/a' && x.to === 'lib')!;
  expect([agg.count, agg.added, agg.removed, agg.change]).toEqual([3, 1, 1, 'mixed']);
  // The ordinary model carries no change info.
  expect(aggregateEdges(buildGraphModel(snap), new Set(['src/a', 'lib'])).edges.every((x) => x.change === undefined)).toBe(true);
});

test('findCycles ignores removed (base-only) edges', () => {
  // Head: lib/u -> lib/v. Base also had lib/v -> lib/u, which would close a cycle.
  const head = { ...snap, edges: [e('lib/u.ts', 'lib/v.ts')] } as unknown as Snapshot;
  const diff = { edges: { added: [], removed: [e('lib/v.ts', 'lib/u.ts')] } } as unknown as SnapshotDiff;
  const m = buildCompareGraphModel(head, diff);
  expect(m.edges.find((x) => x.key === edgeKey('lib/v.ts', 'lib/u.ts'))?.change).toBe('removed');
  const c = findCycles(m);
  expect(c.components).toEqual([]);
  expect(c.edgeKeys.size).toBe(0);
  expect(aggregateEdges(m, new Set(), c).edges.every((x) => x.cycleCount === 0)).toBe(true);
});
