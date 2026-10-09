// Per-repo set of paths hidden from every view, plus pure filters applied before rendering.
// An entry is a file path, or a folder prefix with a trailing `/` that hides everything under it.
import type { FileStatus, Snapshot, SnapshotDiff } from '@codeviz/core';

/** What a right-click landed on: a file, or a directory (path without trailing slash). */
export interface HideTarget {
  kind: 'file' | 'dir';
  path: string;
}

/** The stored entry for a target: folders get a trailing `/`. */
export const hiddenEntry = (t: HideTarget): string => (t.kind === 'dir' ? `${t.path.replace(/\/+$/, '')}/` : t.path);

/**
 * True when `path` is a hidden entry itself, or sits under a hidden folder entry (`a/b/` hides
 * `a/b/c.ts`, `a/b/x/y.ts`, and the directory/module id `a/b`, but not `a/bc/d.ts`).
 */
export function isHidden(path: string, hidden: Set<string>): boolean {
  if (!hidden.size) return false;
  if (hidden.has(path) || hidden.has(`${path}/`)) return true;
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    if (hidden.has(path.slice(0, i + 1))) return true;
  }
  return false;
}

export interface HiddenStore {
  has(path: string): boolean;
  add(path: string): void;
  remove(path: string): void;
  clear(): void;
  /** Sorted entries (folders end in `/`). */
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
  const hid = (p: string) => isHidden(p, hidden);
  const droppedModules = new Set<string>();
  const modules = (snap.modules ?? []).flatMap((m) => {
    const files = m.files.filter((f) => !hid(f));
    if (files.length === m.files.length) return [m];
    if (!files.length) {
      droppedModules.add(m.id);
      return [];
    }
    return [{ ...m, files }];
  });
  const gone = (p: string) => hid(p) || droppedModules.has(p);
  return {
    ...snap,
    files: snap.files.filter((f) => !hid(f.path)),
    functions: snap.functions.filter((f) => !hid(f.file)),
    modules,
    edges: snap.edges.filter((e) => !gone(e.from) && !gone(e.to)),
    coupling: (snap.coupling ?? []).filter((c) => !hid(c.a) && !hid(c.b)),
  };
}

/** `diff` without the hidden files' deltas and edges; totals recomputed from what remains. */
export function filterDiff(diff: SnapshotDiff, hidden: Set<string>): SnapshotDiff {
  if (!hidden.size) return diff;
  const hid = (p: string) => isHidden(p, hidden);
  const files = diff.files.filter((d) => !hid(d.path));
  const keepEdge = (e: { from: string; to: string }) => !hid(e.from) && !hid(e.to);
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
    functions: diff.functions.filter((f) => !hid(f.file)),
    edges: { added, removed },
    totals: { code, loc, files: counts, edges: { added: added.length, removed: removed.length } },
  };
}
