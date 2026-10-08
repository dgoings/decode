// Pure dependency-graph model: no DOM. Nodes are "leaves" (files, opaque modules, or modules
// that have no children) and "groups" (directory/module compounds).
//
// Three snapshot shapes are handled (design seam 4):
//  1. file-level edges + 'dir' modules: dirs nest by path, files are leaves under them;
//  2. module-level edges + 'package' | 'namespace' | 'crate' modules: each module is an opaque
//     leaf (its id is never split into directories, its files never become nodes). A package
//     group exists only for real nesting: when module `a` and module `a/b` both exist, both
//     leaves sit in a compound `a/`;
//  3. both at once: the dir tree and the package nodes coexist, and each edge keeps its level.
import type { FileEntry, Snapshot, SnapshotDiff } from '@codeviz/core';

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
  /**
   * 'file' for files; the module kind ('dir', 'package', 'namespace', 'crate') for modules and
   * module groups; 'module' for a module-edge endpoint with no matching module entry.
   */
  kind: string;
  /** 0 for top-level nodes. */
  depth: number;
  /** File metrics (leaves that are files). */
  metrics?: NodeMetrics;
  /** Groups: files underneath and their summed code lines. Opaque module leaves: their own files. */
  fileCount?: number;
  code?: number;
  /** Compare mode: the node exists only in the base snapshot (endpoint of a removed edge). */
  ghost?: boolean;
}

/** Compare mode: how a model edge differs between base and head (absent = unchanged). */
export type EdgeChange = 'added' | 'removed';

export interface GraphEdge {
  from: string;
  to: string;
  key: string;
  level: 'file' | 'module';
  change?: EdgeChange;
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
  /** 'module' if any merged model edge is module-level, else 'file'. */
  level: 'file' | 'module';
  /** Compare mode: merged edges that were added / removed. */
  added: number;
  removed: number;
  /** Derived from added/removed; undefined when nothing underneath changed. */
  change?: EdgeChange | 'mixed';
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

/** True for nodes whose id is an opaque module id rather than a path (packages, namespaces, crates). */
export const isOpaqueKind = (kind: string): boolean => kind !== 'file' && kind !== 'dir';

export function buildGraphModel(snap: Snapshot): GraphModel {
  const nodes = new Map<string, GraphNode>();
  const children = new Map<string, string[]>();
  const filesByPath = new Map<string, FileEntry>(snap.files.map((f) => [f.path, f]));
  const moduleOfFile = new Map<string, string>();
  const modules = snap.modules ?? [];
  const edges = snap.edges ?? [];
  const dirModules = modules.filter((m) => m.kind === 'dir');

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
      if (isOpaqueKind(existing.kind)) return null; // never nest paths under a package node
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

  // Opaque modules: the snapshot's non-dir modules, plus module-edge endpoints that match no
  // module, file or dir (kind 'module'). Created first so dir/file handling never claims their ids.
  const opaque = new Map<string, { kind: string; files: string[] }>();
  for (const m of modules) if (m.kind !== 'dir') opaque.set(m.id, { kind: m.kind, files: m.files });
  const known = new Set<string>([...modules.map((m) => m.id), ...filesByPath.keys()]);
  for (const e of edges) {
    if (e.level !== 'module') continue;
    for (const id of [e.from, e.to]) if (!known.has(id) && !opaque.has(id)) opaque.set(id, { kind: 'module', files: [] });
  }
  // Nearest proper `/`-prefix that is itself an opaque module; a module with such descendants
  // gets a compound `<id>/` holding itself and them. Otherwise everything stays flat.
  const owner = new Map<string, string>();
  for (const id of opaque.keys()) {
    for (let p = dirname(id); p; p = dirname(p)) {
      if (opaque.has(p)) {
        owner.set(id, p);
        break;
      }
    }
  }
  const nesting = new Set(owner.values());
  const ensureOpaqueGroup = (moduleId: string): string => {
    const gid = `${moduleId}/`;
    if (!nodes.has(gid)) {
      const parent = owner.has(moduleId) ? ensureOpaqueGroup(owner.get(moduleId)!) : null;
      nodes.set(gid, { id: gid, label: `${basename(moduleId)}/`, parent, type: 'group', kind: opaque.get(moduleId)!.kind, depth: 0 });
      link(gid, parent);
    }
    return gid;
  };
  for (const [id, m] of opaque) {
    const o = owner.get(id);
    const parent = nesting.has(id) ? ensureOpaqueGroup(id) : o !== undefined ? ensureOpaqueGroup(o) : null;
    let code = 0;
    for (const f of m.files) code += filesByPath.get(f)?.code ?? 0;
    nodes.set(id, { id, label: basename(id), parent, type: 'leaf', kind: m.kind, depth: 0, fileCount: m.files.length, code });
    link(id, parent);
  }

  for (const m of dirModules) {
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

  for (const m of dirModules) for (const f of m.files) ensureLeaf(f);

  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (e.level === 'module') {
      // Endpoints are module ids: opaque ones already exist; dir modules are groups.
      for (const id of [e.from, e.to]) if (!nodes.has(id) && !ensureGroup(id)) ensureLeaf(id);
    } else {
      ensureLeaf(e.from);
      ensureLeaf(e.to);
    }
    const key = edgeKey(e.from, e.to);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: e.to, key, level: e.level === 'module' ? 'module' : 'file' });
  }

  // Depths, then group totals (deepest first so sums roll up).
  const depthOf = (n: GraphNode): number => (n.parent ? depthOf(nodes.get(n.parent)!) + 1 : 0);
  for (const n of nodes.values()) n.depth = depthOf(n);
  // Groups without member nodes (e.g. a dir module only seen in module-level edges) draw as leaves.
  for (const n of nodes.values()) if (n.type === 'group' && !children.get(n.id)?.length) n.type = 'leaf';
  const byDepth = [...nodes.values()].sort((a, b) => b.depth - a.depth);
  for (const n of byDepth) {
    if (n.type === 'group') {
      n.fileCount ??= 0;
      n.code ??= 0;
    }
    if (!n.parent) continue;
    const p = nodes.get(n.parent)!;
    const files = n.kind === 'file' ? 1 : (n.fileCount ?? 0);
    const code = n.kind === 'file' ? (n.metrics?.code ?? 0) : (n.code ?? 0);
    p.fileCount = (p.fileCount ?? 0) + files;
    p.code = (p.code ?? 0) + code;
  }
  return { nodes, children, edges: out };
}

/**
 * Head's graph with the diff's edge changes marked: head edges in `diff.edges.added` become
 * `added`; `diff.edges.removed` edges are added as `removed` (unless head still has an edge between
 * the same endpoints). Removed-edge endpoints missing from head become ghost leaves under their
 * directory group (created, also as a ghost, if head no longer has it).
 */
export function buildCompareGraphModel(head: Snapshot, diff: SnapshotDiff): GraphModel {
  const model = buildGraphModel(head);
  const { nodes, children } = model;
  const added = new Set(diff.edges.added.map((e) => edgeKey(e.from, e.to)));
  for (const e of model.edges) if (added.has(e.key)) e.change = 'added';

  const link = (id: string, parent: string | null) => {
    const k = parent ?? '';
    (children.get(k) ?? children.set(k, []).get(k)!).push(id);
  };
  const ensureGhostGroup = (id: string): string | null => {
    if (!id || id === ROOT_MODULE) return null;
    const n = nodes.get(id);
    if (n) return n.type === 'group' ? id : null;
    const parent = ensureGhostGroup(dirname(id));
    nodes.set(id, { id, label: basename(id), parent, type: 'group', kind: 'dir', depth: 0, ghost: true, fileCount: 0, code: 0 });
    link(id, parent);
    return id;
  };
  const ensureGhost = (id: string, level: 'file' | 'module'): void => {
    if (nodes.has(id)) return;
    const parent = level === 'file' ? ensureGhostGroup(dirname(id)) : null;
    nodes.set(id, { id, label: basename(id), parent, type: 'leaf', kind: level === 'file' ? 'file' : 'module', depth: 0, ghost: true });
    link(id, parent);
  };

  const have = new Set(model.edges.map((e) => e.key));
  for (const e of diff.edges.removed) {
    const key = edgeKey(e.from, e.to);
    if (e.from === e.to || have.has(key)) continue;
    have.add(key);
    ensureGhost(e.from, e.level);
    ensureGhost(e.to, e.level);
    model.edges.push({ from: e.from, to: e.to, key, level: e.level, change: 'removed' });
  }
  const depthOf = (n: GraphNode): number => (n.parent ? depthOf(nodes.get(n.parent)!) + 1 : 0);
  for (const n of nodes.values()) if (n.ghost) n.depth = depthOf(n);
  return model;
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
    if (!v) merged.set(id, (v = { id, from, to, count: 0, cycleCount: 0, level: e.level, added: 0, removed: 0 }));
    else if (e.level === 'module') v.level = 'module';
    v.count++;
    if (cycles?.edgeKeys.has(e.key)) v.cycleCount++;
    if (e.change === 'added') v.added++;
    else if (e.change === 'removed') v.removed++;
  }
  for (const v of merged.values()) {
    if (v.added || v.removed) v.change = v.added && v.removed ? 'mixed' : v.added ? 'added' : 'removed';
  }
  return { nodes, edges: [...merged.values()], repOf };
}

/** Edges that exist in the snapshot being drawn: compare-mode `removed` edges are base-only. */
const liveEdges = (model: GraphModel): GraphEdge[] => model.edges.filter((e) => e.change !== 'removed');

/**
 * Tarjan's SCC over the model edges (iterative, so deep import chains cannot overflow the stack).
 * Removed (base-only) edges are ignored, so cycles are always the head snapshot's own.
 */
export function findCycles(model: GraphModel): Cycles {
  const edges = liveEdges(model);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
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
  for (const e of edges) vertices.add(e.from).add(e.to);

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
  for (const e of edges) {
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
  for (const e of liveEdges(model)) {
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
