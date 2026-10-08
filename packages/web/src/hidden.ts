// Per-repo set of file paths hidden from every view, plus pure filters applied before rendering.
import type { FileStatus, Snapshot, SnapshotDiff } from '@codeviz/core';

export interface HiddenStore {
  has(path: string): boolean;
  add(path: string): void;
  remove(path: string): void;
  clear(): void;
  /** Sorted paths. */
  list(): string[];
  /** Called after every change; returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
}

/** Backed by localStorage `codeviz:hidden:<repoId>`; falls back to memory when storage is unavailable. */
export function createHiddenStore(repoId: string): HiddenStore {
  const key = `codeviz:hidden:${repoId}`;
  let paths = new Set<string>();
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) paths = new Set(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    // storage blocked or corrupt: start empty, keep in memory
  }
  const listeners = new Set<() => void>();
  const commit = () => {
    try {
      if (paths.size) localStorage.setItem(key, JSON.stringify([...paths]));
      else localStorage.removeItem(key);
    } catch {
      // in-memory only
    }
    for (const cb of listeners) cb();
  };
  return {
    has: (p) => paths.has(p),
    add(p) {
      if (paths.has(p)) return;
      paths.add(p);
      commit();
    },
    remove(p) {
      if (paths.delete(p)) commit();
    },
    clear() {
      if (!paths.size) return;
      paths.clear();
      commit();
    },
    list: () => [...paths].sort(),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * `snap` without the hidden files: drops their file entries, functions, coupling pairs, and module
 * memberships (modules left empty go too), and every edge touching a hidden file or dropped module.
 */
export function filterSnapshot(snap: Snapshot, hidden: Set<string>): Snapshot {
  if (!hidden.size) return snap;
  const droppedModules = new Set<string>();
  const modules = (snap.modules ?? []).flatMap((m) => {
    const files = m.files.filter((f) => !hidden.has(f));
    if (files.length === m.files.length) return [m];
    if (!files.length) {
      droppedModules.add(m.id);
      return [];
    }
    return [{ ...m, files }];
  });
  const gone = (p: string) => hidden.has(p) || droppedModules.has(p);
  return {
    ...snap,
    files: snap.files.filter((f) => !hidden.has(f.path)),
    functions: snap.functions.filter((f) => !hidden.has(f.file)),
    modules,
    edges: snap.edges.filter((e) => !gone(e.from) && !gone(e.to)),
    coupling: (snap.coupling ?? []).filter((c) => !hidden.has(c.a) && !hidden.has(c.b)),
  };
}

/** `diff` without the hidden files' deltas and edges; totals recomputed from what remains. */
export function filterDiff(diff: SnapshotDiff, hidden: Set<string>): SnapshotDiff {
  if (!hidden.size) return diff;
  const files = diff.files.filter((d) => !hidden.has(d.path));
  const keepEdge = (e: { from: string; to: string }) => !hidden.has(e.from) && !hidden.has(e.to);
  const added = diff.edges.added.filter(keepEdge);
  const removed = diff.edges.removed.filter(keepEdge);
  const counts: Record<FileStatus, number> = { added: 0, removed: 0, modified: 0, renamed: 0, unchanged: 0 };
  let code = 0;
  let loc = 0;
  for (const d of files) {
    counts[d.status]++;
    code += d.code;
    loc += d.loc;
  }
  return {
    ...diff,
    files,
    functions: diff.functions.filter((f) => !hidden.has(f.file)),
    edges: { added, removed },
    totals: { code, loc, files: counts, edges: { added: added.length, removed: removed.length } },
  };
}
