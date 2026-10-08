// Pure helpers for the compare view (no DOM).
import type { EdgeEntry, FileDelta, FileEntry, ModuleEntry, Snapshot, SnapshotDiff } from '@codeviz/core';

/** Stands in for '/' in flattened directory group ids (U+2215 DIVISION SLASH). */
export const DIR_SEP = '\u2215';

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

export type SliceKind = 'grow' | 'shrink' | 'added' | 'removed';
export interface Slice {
  kind: SliceKind;
  /** Fraction of the block width in (0, 1]: added lines / head code, or removed lines / base code. */
  frac: number;
}

/**
 * Growth/shrink slice for one treemap block. Net code delta only: growth is Δ/headCode, shrink is
 * −Δ/baseCode. Added and removed files are full width. Null when the code size did not change.
 */
export function sliceFor(d: FileDelta | undefined, f: FileEntry): Slice | null {
  if (!d || d.status === 'unchanged') return null;
  if (d.status === 'added') return { kind: 'added', frac: 1 };
  if (d.status === 'removed') return { kind: 'removed', frac: 1 };
  if (d.code === 0) return null;
  const clamp = (x: number) => (Number.isFinite(x) && x > 0 ? Math.min(1, x) : 1);
  if (d.code > 0) return { kind: 'grow', frac: clamp(d.code / (d.head?.code ?? f.code ?? 0)) };
  const baseCode = d.base?.code ?? (f.code ?? 0) - d.code;
  return { kind: 'shrink', frac: clamp(-d.code / baseCode) };
}

export type EdgeFilter = 'all' | 'added' | 'removed';

/**
 * Snapshot-shaped input for the graph view holding only changed edges. Edge `kind` is replaced by
 * 'added' / 'removed'; only the endpoints are included.
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
  // File endpoints are grouped one level deep by directory (the id has no '/', so the graph view
  // neither nests nor collapses it); the graph view collapses deeper groups, which would hide most
  // changed edges. Module-level endpoints keep head's modules.
  const byDir = new Map<string, string[]>();
  const fileLevel = new Set(edges.filter((e) => e.level === 'file').flatMap((e) => [e.from, e.to]));
  for (const p of fileLevel) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (!dir) continue;
    const list = byDir.get(dir);
    if (list) list.push(p);
    else byDir.set(dir, [p]);
  }
  const modules: ModuleEntry[] = [
    ...[...byDir].map(([dir, files]) => ({ id: dir.replaceAll('/', DIR_SEP), kind: 'dir' as const, files })),
    ...(head.modules ?? []).filter((m) => ends.has(m.id) && !fileLevel.has(m.id)),
  ];
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
