// Pure dependency-graph model: no DOM. Nodes are "leaves" (files, or modules that have no
// children) and "groups" (directory/module compounds). Nothing here depends on whether
// edges are file-level or module-level, so a module-only snapshot renders the same way.
import type { FileEntry, Snapshot } from '@codeviz/core';

export interface NodeMetrics {
  code?: number;
  complexityMax?: number;
  churnCommits?: number;
}

export interface GraphNode {
  id: string;
  label: string;
  /** Enclosing group id, or null at the top level. */
  parent: string | null;
  /** 'group' = directory/module compound; 'leaf' = file (or a module with no member nodes). */
  type: 'group' | 'leaf';
  /** Module kind for groups ('dir', 'package', ...); 'file' for files. */
  kind: string;
  /** 0 for top-level nodes. */
  depth: number;
  /** File metrics (leaves that are files). */
  metrics?: NodeMetrics;
  /** Groups: number of file leaves underneath and their summed code lines. */
  fileCount?: number;
  code?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  key: string;
  level: 'file' | 'module';
}

export interface GraphModel {
  nodes: Map<string, GraphNode>;
  /** Child ids per group id ('' = top level), in insertion order. */
  children: Map<string, string[]>;
  /** Deduped by (from, to); self-loops dropped. */
  edges: GraphEdge[];
}

export interface VisibleEdge {
  id: string;
  from: string;
  to: string;
  /** Number of underlying model edges merged into this one. */
  count: number;
  /** How many of those lie inside a cycle (see findCycles). */
  cycleCount: number;
}

export interface VisibleGraph {
  /** Nodes to draw, parents before children. Collapsed groups are drawn as leaves. */
  nodes: Array<GraphNode & { collapsed: boolean }>;
  edges: VisibleEdge[];
  /** Model node id -> id of the visible node that represents it. */
  repOf(id: string): string;
}

export interface Cycles {
  /** Strongly connected components with more than one node, largest first. */
  components: string[][];
  /** edgeKey(from, to) of every model edge whose endpoints share a component. */
  edgeKeys: Set<string>;
}

export const edgeKey = (from: string, to: string): string => `${from}\n${to}`;

const ROOT_MODULE = '.';
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function buildGraphModel(snap: Snapshot): GraphModel {
  const nodes = new Map<string, GraphNode>();
  const children = new Map<string, string[]>();
  const filesByPath = new Map<string, FileEntry>(snap.files.map((f) => [f.path, f]));
  const moduleOfFile = new Map<string, string>();
  const modules = snap.modules ?? [];
  const edges = snap.edges ?? [];

  const link = (id: string, parent: string | null) => {
    const k = parent ?? '';
    const list = children.get(k);
    if (list) list.push(id);
    else children.set(k, [id]);
  };

  /** Group for a path-like id, creating intermediate directories ('src/a/b' -> 'src/a' -> 'src'). */
  const ensureGroup = (id: string, kind = 'dir'): string | null => {
    if (!id || id === ROOT_MODULE) return null;
    const existing = nodes.get(id);
    if (existing) {
      if (existing.type === 'group') return id;
      // A path we first saw as an edge endpoint turned out to be a module: promote it.
      existing.type = 'group';
      existing.kind = kind;
      return id;
    }
    const parent = ensureGroup(dirname(id));
    nodes.set(id, { id, label: basename(id), parent, type: 'group', kind, depth: 0 });
    link(id, parent);
    return id;
  };

  for (const m of modules) {
    ensureGroup(m.id, m.kind);
    for (const f of m.files) moduleOfFile.set(f, m.id);
  }

  const ensureLeaf = (id: string): void => {
    if (nodes.has(id)) return;
    const f = filesByPath.get(id);
    const parent = ensureGroup(moduleOfFile.get(id) ?? dirname(id));
    const node: GraphNode = { id, label: basename(id), parent, type: 'leaf', kind: 'file', depth: 0 };
    if (f) node.metrics = { code: f.code, complexityMax: f.complexity?.max, churnCommits: f.churn?.commits };
    nodes.set(id, node);
    link(id, parent);
  };

  for (const m of modules) for (const f of m.files) ensureLeaf(f);

  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (e.level === 'module') {
      for (const id of [e.from, e.to]) if (!nodes.has(id) && !ensureGroup(id)) ensureLeaf(id);
    } else {
      ensureLeaf(e.from);
      ensureLeaf(e.to);
    }
    const key = edgeKey(e.from, e.to);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: e.to, key, level: e.level });
  }

  // Depths, then group totals (deepest first so sums roll up).
  const depthOf = (n: GraphNode): number => (n.parent ? depthOf(nodes.get(n.parent)!) + 1 : 0);
  for (const n of nodes.values()) n.depth = depthOf(n);
  // Groups without member nodes (e.g. a module only seen in module-level edges) draw as leaves.
  for (const n of nodes.values()) if (n.type === 'group' && !children.get(n.id)?.length) n.type = 'leaf';
  const byDepth = [...nodes.values()].sort((a, b) => b.depth - a.depth);
  for (const n of byDepth) {
    if (n.type === 'group') {
      n.fileCount ??= 0;
      n.code ??= 0;
    }
    if (!n.parent) continue;
    const p = nodes.get(n.parent)!;
    p.fileCount = (p.fileCount ?? 0) + (n.type === 'group' ? n.fileCount! : n.kind === 'file' ? 1 : 0);
    p.code = (p.code ?? 0) + (n.type === 'group' ? n.code! : (n.metrics?.code ?? 0));
  }
  return { nodes, children, edges: out };
}

/** Group ids at `depth` or deeper: the collapsed set that shows `depth` levels of groups expanded. */
export function groupsBelow(model: GraphModel, depth: number): Set<string> {
  const out = new Set<string>();
  for (const n of model.nodes.values()) if (n.type === 'group' && n.depth >= depth) out.add(n.id);
  return out;
}

/** Ancestor ids of `id`, nearest first. */
export function ancestors(model: GraphModel, id: string): string[] {
  const out: string[] = [];
  for (let p = model.nodes.get(id)?.parent ?? null; p; p = model.nodes.get(p)?.parent ?? null) out.push(p);
  return out;
}

/**
 * Visible nodes for a set of collapsed group ids, and model edges re-targeted to the nearest
 * visible ancestor (the outermost collapsed one), merged with a count. Self-loops are dropped.
 */
export function aggregateEdges(model: GraphModel, collapsed: Set<string>, cycles?: Cycles): VisibleGraph {
  const reps = new Map<string, string>();
  const repOf = (id: string): string => {
    let rep = reps.get(id);
    if (rep !== undefined) return rep;
    rep = id;
    for (const a of ancestors(model, id)) if (collapsed.has(a)) rep = a;
    reps.set(id, rep);
    return rep;
  };

  const nodes: VisibleGraph['nodes'] = [];
  for (const n of [...model.nodes.values()].sort((a, b) => a.depth - b.depth)) {
    if (repOf(n.id) === n.id) nodes.push({ ...n, collapsed: n.type === 'group' && collapsed.has(n.id) });
  }

  const merged = new Map<string, VisibleEdge>();
  for (const e of model.edges) {
    const from = repOf(e.from);
    const to = repOf(e.to);
    if (from === to) continue;
    const id = edgeKey(from, to);
    let v = merged.get(id);
    if (!v) merged.set(id, (v = { id, from, to, count: 0, cycleCount: 0 }));
    v.count++;
    if (cycles?.edgeKeys.has(e.key)) v.cycleCount++;
  }
  return { nodes, edges: [...merged.values()], repOf };
}

/** Tarjan's SCC over the model edges (iterative, so deep import chains cannot overflow the stack). */
export function findCycles(model: GraphModel): Cycles {
  const adj = new Map<string, string[]>();
  for (const e of model.edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;

  const vertices = new Set<string>();
  for (const e of model.edges) vertices.add(e.from).add(e.to);

  for (const start of vertices) {
    if (index.has(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const out = adj.get(frame.v) ?? [];
      if (frame.i < out.length) {
        const w = out[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      if (low.get(frame.v) === index.get(frame.v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.v);
        if (comp.length > 1) components.push(comp.sort());
      }
    }
  }
  components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));

  const compOf = new Map<string, number>();
  components.forEach((c, i) => c.forEach((v) => compOf.set(v, i)));
  const edgeKeys = new Set<string>();
  for (const e of model.edges) {
    const c = compOf.get(e.from);
    if (c !== undefined && c === compOf.get(e.to)) edgeKeys.add(e.key);
  }
  return { components, edgeKeys };
}

/** One concrete cycle through a component's first node (shortest, via BFS), e.g. [a, b, c] for a → b → c → a. */
export function cyclePath(model: GraphModel, component: string[]): string[] {
  const members = new Set(component);
  const start = component[0]!;
  const prev = new Map<string, string>();
  const queue = [start];
  const adj = new Map<string, string[]>();
  for (const e of model.edges) {
    if (members.has(e.from) && members.has(e.to)) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  }
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!;
    for (const w of adj.get(v) ?? []) {
      if (w === start) {
        const path = [v];
        for (let p = v; p !== start; ) path.unshift((p = prev.get(p)!));
        return path;
      }
      if (!prev.has(w) && w !== start) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return component;
}
