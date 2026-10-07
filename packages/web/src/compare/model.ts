// Pure helpers for the compare view (no DOM).
import type { EdgeEntry, FileDelta, FileEntry, Snapshot, SnapshotDiff } from '@codeviz/core';

/**
 * Files for the delta treemap: head's files (area = head size), plus removed files at their base
 * size so they still show in head's hierarchy. `changedOnly` drops unchanged files.
 */
export function deltaFiles(headFiles: FileEntry[], diff: SnapshotDiff, changedOnly: boolean): FileEntry[] {
  const status = new Map(diff.files.map((d) => [d.path, d.status]));
  const out = headFiles.filter((f) => !changedOnly || (status.get(f.path) ?? 'unchanged') !== 'unchanged');
  for (const d of diff.files) {
    if (d.status === 'removed' && d.base) out.push({ ...d.base, path: d.path });
  }
  return out;
}

export type SortKey = 'path' | 'status' | 'code' | 'loc' | 'complexitySum' | 'complexityMax' | 'churnCommits';
export interface SortSpec {
  key: SortKey;
  /** Numeric columns sort by absolute delta; `desc` puts the biggest change first. */
  desc: boolean;
}

export const DEFAULT_SORT: SortSpec = { key: 'code', desc: true };

/** Comparator for the biggest-changes table. Ties fall back to path ascending. */
export function compareDeltas(spec: SortSpec): (a: FileDelta, b: FileDelta) => number {
  const { key, desc } = spec;
  const byPath = (a: FileDelta, b: FileDelta) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return (a, b) => {
    let c: number;
    if (key === 'path' || key === 'status') {
      const x = a[key];
      const y = b[key];
      c = x < y ? -1 : x > y ? 1 : 0;
    } else {
      c = Math.abs(a[key]) - Math.abs(b[key]);
    }
    if (desc) c = -c;
    return c || byPath(a, b);
  };
}

/** Changed files (everything but `unchanged`), sorted. */
export function changedRows(diff: SnapshotDiff, spec: SortSpec = DEFAULT_SORT): FileDelta[] {
  return diff.files.filter((d) => d.status !== 'unchanged').sort(compareDeltas(spec));
}

export type EdgeFilter = 'all' | 'added' | 'removed';

/**
 * Snapshot-shaped input for the graph view holding only changed edges. Edge `kind` is replaced by
 * 'added' / 'removed'; modules are head's modules narrowed to the endpoints so unrelated files stay out.
 */
export function edgeSnapshot(diff: SnapshotDiff, head: Snapshot, filter: EdgeFilter = 'all'): Snapshot {
  const edges: EdgeEntry[] = [];
  if (filter !== 'removed') for (const e of diff.edges.added) edges.push({ ...e, kind: 'added' });
  if (filter !== 'added') for (const e of diff.edges.removed) edges.push({ ...e, kind: 'removed' });
  const ends = new Set(edges.flatMap((e) => [e.from, e.to]));
  const baseOf = new Map(diff.files.filter((d) => d.base).map((d) => [d.path, d.base!]));
  const files: FileEntry[] = head.files.filter((f) => ends.has(f.path));
  const have = new Set(files.map((f) => f.path));
  for (const p of ends) {
    const b = baseOf.get(p);
    if (b && !have.has(p)) files.push({ ...b, path: p });
  }
  const modules = (head.modules ?? [])
    .map((m) => ({ ...m, files: m.files.filter((f) => ends.has(f)) }))
    .filter((m) => m.files.length || ends.has(m.id));
  return {
    ...head,
    ref: 'Changed edges',
    files,
    functions: [],
    modules,
    edges,
    coupling: [],
  };
}
