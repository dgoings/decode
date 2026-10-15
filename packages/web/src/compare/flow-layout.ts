// Pure layout for a step's flow graph (no DOM): levels top to bottom, siblings side by side.
import type { Flow, FlowNode } from '@codeviz/core';

export const NODE_W = 150;
export const NODE_H = 38;
const GAP_X = 14;
const GAP_Y = 18;
const PAD = 6;

export interface LaidNode extends FlowNode {
  x: number;
  y: number;
  level: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  /** SVG path from the bottom of `from` to the top of `to`. */
  d: string;
}

export interface Layout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  width: number;
  height: number;
}

/** Longest path from any root, so a node always sits below everything that feeds it. Cycles are cut. */
function levels(flow: Flow): Map<string, number> {
  const into = new Map<string, string[]>();
  for (const [a, b] of flow.edges) {
    const list = into.get(b);
    if (list) list.push(a);
    else into.set(b, [a]);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let l = 0;
    for (const p of into.get(id) ?? []) l = Math.max(l, level(p) + 1);
    visiting.delete(id);
    memo.set(id, l);
    return l;
  };
  for (const n of flow.nodes) level(n.id);
  return memo;
}

export function layoutFlow(flow: Flow): Layout {
  const ids = new Set(flow.nodes.map((n) => n.id));
  const edges = flow.edges.filter(([a, b]) => ids.has(a) && ids.has(b));
  const lv = levels({ nodes: flow.nodes, edges });
  // Cutting a cycle can leave a level empty; number the used levels densely so no row is a hole.
  const rank = new Map([...new Set(lv.values())].sort((a, b) => a - b).map((l, i) => [l, i]));
  const rows: FlowNode[][] = [];
  for (const n of flow.nodes) (rows[rank.get(lv.get(n.id) ?? 0) ?? 0] ??= []).push(n);
  const widest = Math.max(1, ...rows.map((r) => r?.length ?? 0));
  const width = widest * NODE_W + (widest - 1) * GAP_X + PAD * 2;
  const nodes: LaidNode[] = [];
  rows.forEach((row, level) => {
    if (!row) return;
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    const x0 = (width - rowW) / 2;
    row.forEach((n, i) => nodes.push({ ...n, level, x: x0 + i * (NODE_W + GAP_X), y: PAD + level * (NODE_H + GAP_Y) }));
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const laid: LaidEdge[] = edges.map(([from, to]) => {
    const a = at.get(from)!;
    const b = at.get(to)!;
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    const k = Math.max(10, (y2 - y1) / 2);
    return { from, to, d: `M${x1} ${y1} C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}` };
  });
  const height = PAD * 2 + rows.length * NODE_H + Math.max(0, rows.length - 1) * GAP_Y;
  return { nodes, edges: laid, width, height };
}

/** Shorten the middle of a path-like string, keeping the end (the file name) readable. */
export function clipEnd(s: string, max: number): string {
  return s.length <= max ? s : `…${s.slice(s.length - (max - 1))}`;
}

export function clipTail(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Where a node lives, short enough for the box: the last two path segments and the line. Screens
 * and components point at a whole file, so they show no line.
 */
export function nodeWhere(n: { kind: string; file?: string; line?: number }): string {
  if (!n.file) return '';
  const tail = n.file.split('/').slice(-2).join('/');
  return n.line && n.kind !== 'screen' && n.kind !== 'component' ? `${tail}:${n.line}` : tail;
}
