import type { EdgeEntry, FileEntry, FunctionEntry, Snapshot } from './snapshot.ts';
import type { RenameMap } from './rename.ts';

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'unchanged';

export interface FileDelta {
  path: string;
  /** Base path when the file was renamed. */
  oldPath?: string;
  status: FileStatus;
  /** Metric deltas are head - base (missing values count as 0). */
  code: number;
  loc: number;
  comments: number;
  complexitySum: number;
  complexityMax: number;
  churnCommits: number;
  /** Omitted on `unchanged` entries to keep them cheap. */
  base?: FileEntry;
  head?: FileEntry;
}

export interface FunctionDelta {
  file: string;
  name: string;
  status: 'added' | 'removed' | 'modified';
  /** head - base */
  complexity: number;
  baseComplexity?: number;
  headComplexity?: number;
}

export interface EdgeDelta {
  from: string;
  to: string;
  kind: string;
  level: 'file' | 'module';
}

export interface SnapshotDiff {
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  renames: RenameMap;
  files: FileDelta[];
  functions: FunctionDelta[];
  edges: { added: EdgeDelta[]; removed: EdgeDelta[] };
  totals: {
    code: number;
    loc: number;
    files: { added: number; removed: number; modified: number; renamed: number; unchanged: number };
    edges: { added: number; removed: number };
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function metrics(f: FileEntry | undefined) {
  return {
    code: f?.code ?? 0,
    loc: f?.loc ?? 0,
    comments: f?.comments ?? 0,
    complexitySum: f?.complexity?.sum ?? 0,
    complexityMax: f?.complexity?.max ?? 0,
    churnCommits: f?.churn?.commits ?? 0,
  };
}

/**
 * Compare two snapshots. Base paths are mapped through `renames` first so a
 * moved file is compared with itself. Status reflects content metrics
 * (code/loc/comments/complexity); churn is reported as a delta but does not
 * by itself make a file `modified`, since history shifts even for untouched files.
 */
export function diffSnapshots(base: Snapshot, head: Snapshot, renames: RenameMap = {}): SnapshotDiff {
  const headFiles = new Map(head.files.map((f) => [f.path, f]));
  const basePaths = new Set(base.files.map((f) => f.path));
  // Only follow a rename when the target exists in head and does not collide with a base file.
  const fileRename = (p: string): string => {
    const to = renames[p];
    return to !== undefined && to !== p && headFiles.has(to) && !basePaths.has(to) ? to : p;
  };

  const baseFiles = new Map<string, { entry: FileEntry; oldPath?: string }>();
  for (const f of base.files) {
    const p = fileRename(f.path);
    baseFiles.set(p, p === f.path ? { entry: f } : { entry: f, oldPath: f.path });
  }

  const files: FileDelta[] = [];
  const totals: SnapshotDiff['totals'] = {
    code: 0,
    loc: 0,
    files: { added: 0, removed: 0, modified: 0, renamed: 0, unchanged: 0 },
    edges: { added: 0, removed: 0 },
  };
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort(cmp);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const mb = metrics(b?.entry);
    const mh = metrics(h);
    const d = {
      code: mh.code - mb.code,
      loc: mh.loc - mb.loc,
      comments: mh.comments - mb.comments,
      complexitySum: mh.complexitySum - mb.complexitySum,
      complexityMax: mh.complexityMax - mb.complexityMax,
      churnCommits: mh.churnCommits - mb.churnCommits,
    };
    const changed = d.code || d.loc || d.comments || d.complexitySum || d.complexityMax;
    const status: FileStatus = !b ? 'added' : !h ? 'removed' : b.oldPath ? 'renamed' : changed ? 'modified' : 'unchanged';
    totals.files[status]++;
    totals.code += d.code;
    totals.loc += d.loc;
    const delta: FileDelta = { path, status, ...d };
    if (b?.oldPath) delta.oldPath = b.oldPath;
    if (status !== 'unchanged') {
      if (b) delta.base = b.entry;
      if (h) delta.head = h;
    }
    files.push(delta);
  }

  // Functions: match by (file after rename, name); same-named functions in a file pair up in line order.
  const group = (fns: FunctionEntry[], mapFile: (p: string) => string) => {
    const m = new Map<string, FunctionEntry[]>();
    for (const fn of fns) {
      const key = `${mapFile(fn.file)}\0${fn.name}`;
      const list = m.get(key);
      if (list) list.push(fn);
      else m.set(key, [fn]);
    }
    for (const list of m.values()) list.sort((a, b) => a.line - b.line);
    return m;
  };
  const baseFns = group(base.functions, fileRename);
  const headFns = group(head.functions, (p) => p);
  const functions: FunctionDelta[] = [];
  for (const key of new Set([...baseFns.keys(), ...headFns.keys()])) {
    const [file, name] = key.split('\0') as [string, string];
    const bl = baseFns.get(key) ?? [];
    const hl = headFns.get(key) ?? [];
    for (let i = 0; i < Math.max(bl.length, hl.length); i++) {
      const bc = bl[i]?.complexity;
      const hc = hl[i]?.complexity;
      if (bc === undefined) functions.push({ file, name, status: 'added', complexity: hc!, headComplexity: hc });
      else if (hc === undefined) functions.push({ file, name, status: 'removed', complexity: -bc, baseComplexity: bc });
      else if (bc !== hc)
        functions.push({ file, name, status: 'modified', complexity: hc - bc, baseComplexity: bc, headComplexity: hc });
    }
  }
  functions.sort((a, b) => cmp(a.file, b.file) || cmp(a.name, b.name));

  // Edges: rename base endpoints (module ids are unaffected), then set difference.
  const edgeKey = (e: EdgeDelta) => `${e.from}\0${e.to}\0${e.kind}\0${e.level}`;
  const toDelta = (e: EdgeEntry, map: (p: string) => string): EdgeDelta => ({
    from: map(e.from),
    to: map(e.to),
    kind: e.kind,
    level: e.level,
  });
  const edgeRename = (p: string) => renames[p] ?? p;
  const baseEdges = new Map(base.edges.map((e) => toDelta(e, edgeRename)).map((e) => [edgeKey(e), e]));
  const headEdges = new Map(head.edges.map((e) => toDelta(e, (p) => p)).map((e) => [edgeKey(e), e]));
  const edgeOrder = (a: EdgeDelta, b: EdgeDelta) =>
    cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.level, b.level) || cmp(a.kind, b.kind);
  const added = [...headEdges].filter(([k]) => !baseEdges.has(k)).map(([, e]) => e).sort(edgeOrder);
  const removed = [...baseEdges].filter(([k]) => !headEdges.has(k)).map(([, e]) => e).sort(edgeOrder);
  totals.edges = { added: added.length, removed: removed.length };

  return {
    base: { sha: base.sha, ref: base.ref },
    head: { sha: head.sha, ref: head.ref },
    renames,
    files,
    functions,
    edges: { added, removed },
    totals,
  };
}
