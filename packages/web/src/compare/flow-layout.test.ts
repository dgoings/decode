import { expect, test } from 'bun:test';
import type { Flow, PlanStep } from '@codeviz/core';
import { clipEnd, clipTail, layoutFlow, NODE_H, NODE_W, nodeWhere } from './flow-layout.ts';
import { flowWithPath } from './testplan-model.ts';

const node = (id: string, label = id) => ({ id, kind: 'call' as const, label });

test('levels follow the longest path; siblings share a row and are centred', () => {
  const flow: Flow = {
    nodes: [node('a'), node('b'), node('c'), node('d')],
    edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
  };
  const l = layoutFlow(flow);
  const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  expect([by.a!.level, by.b!.level, by.c!.level, by.d!.level]).toEqual([0, 1, 1, 2]);
  expect(by.b!.y).toBe(by.c!.y);
  expect(by.b!.x).toBeLessThan(by.c!.x);
  // a and d sit centred over the two-wide row
  expect(by.a!.x + NODE_W / 2).toBeCloseTo((by.b!.x + by.c!.x + NODE_W) / 2);
  expect(l.height).toBeGreaterThan(3 * NODE_H);
  expect(l.edges).toHaveLength(4);
  expect(l.edges[0]!.d.startsWith('M')).toBe(true);
});

test('a node is placed below everything feeding it, even through a long path', () => {
  const l = layoutFlow({ nodes: [node('a'), node('b'), node('c')], edges: [['a', 'b'], ['b', 'c'], ['a', 'c']] });
  expect(l.nodes.find((n) => n.id === 'c')!.level).toBe(2);
});

test('cycles and dangling edges do not break layout', () => {
  const l = layoutFlow({ nodes: [node('a'), node('b')], edges: [['a', 'b'], ['b', 'a'], ['a', 'zzz']] });
  expect(l.nodes).toHaveLength(2);
  expect(l.edges.every((e) => e.from !== 'zzz' && e.to !== 'zzz')).toBe(true);
});

test('a pure cycle (no root) still lays out to finite sizes with no empty rows', () => {
  const l = layoutFlow({ nodes: [node('a'), node('b')], edges: [['a', 'b'], ['b', 'a']] });
  expect(Number.isFinite(l.width) && Number.isFinite(l.height)).toBe(true);
  expect(l.nodes.map((n) => n.level).sort()).toEqual([0, 1]);
  expect(l.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
});

test('an empty flow lays out to a small box', () => {
  const l = layoutFlow({ nodes: [], edges: [] });
  expect(l.nodes).toEqual([]);
  expect(l.width).toBeGreaterThan(0);
});

test('clipping keeps the useful end', () => {
  expect(clipEnd('src/components/TagsSettingsSection.tsx:38', 20)).toBe('…tingsSection.tsx:38');
  expect(clipEnd('a.ts:1', 20)).toBe('a.ts:1');
  expect(clipTail('Click the very long label here', 12)).toBe('Click the v…');
});

const step = (): PlanStep => ({
  kind: 'click', area: 'A', text: 't', checks: [], why: [], file: 'src/ui/Save.tsx', line: 3,
  flow: { nodes: [{ id: 'n0', kind: 'element', label: 'Save' }, { id: 'n1', kind: 'call', label: 'api.save' }], edges: [['n0', 'n1']] },
});

test('flowWithPath puts the screen (and what lies between) in front of the step graph', () => {
  const direct = flowWithPath(step(), ['pages/users/[id].tsx', 'src/ui/Save.tsx'], '/users/:id');
  expect(direct.nodes.map((n) => [n.kind, n.label])).toEqual([['screen', 'Users › (id)'], ['element', 'Save'], ['call', 'api.save']]);
  expect(direct.edges).toEqual([['p0', 'n0'], ['n0', 'n1']]);

  const one = flowWithPath(step(), ['pages/a.tsx', 'src/Form.tsx', 'src/ui/Save.tsx'], '/a');
  expect(one.nodes.map((n) => n.label).slice(0, 2)).toEqual(['A', 'Form']);
  const many = flowWithPath(step(), ['pages/a.tsx', 'x/B.tsx', 'x/C.tsx', 'x/D.tsx', 'src/ui/Save.tsx'], '/a');
  expect(many.nodes[1]).toMatchObject({ kind: 'component', label: '3 components' });
  expect(many.edges.slice(0, 2)).toEqual([['p0', 'p1'], ['p1', 'n0']]);
});

test('without a chain (shared code) the flow is unchanged', () => {
  const s = step();
  expect(flowWithPath(s, undefined, '/a')).toBe(s.flow);
});

test('nodeWhere shows the last two path segments, and a line only for code spots', () => {
  expect(nodeWhere({ kind: 'call', file: 'convex/taskTags.ts', line: 88 })).toBe('convex/taskTags.ts:88');
  expect(nodeWhere({ kind: 'element', file: 'src/routes/admin/settings.tsx', line: 566 })).toBe('admin/settings.tsx:566');
  expect(nodeWhere({ kind: 'screen', file: 'src/routes/admin/settings.tsx', line: 1 })).toBe('admin/settings.tsx');
  expect(nodeWhere({ kind: 'component', file: 'src/components/TagsSettingsSection.tsx', line: 1 })).toBe('components/TagsSettingsSection.tsx');
  expect(nodeWhere({ kind: 'call', label: 'x' } as never)).toBe('');
});
