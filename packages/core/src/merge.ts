import type { FileEntry, Snapshot, SnapshotMeta } from './snapshot.ts';

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Combine partial snapshots into one complete Snapshot.
 *
 * Conflict rule: parts are applied in order and LATER PARTS WIN. For files
 * sharing a path, records merge field-wise: a later defined value overrides an
 * earlier scalar (e.g. loc), and nested objects (complexity, churn) are replaced
 * whole by the later part. Undefined fields never override. `languages` is a
 * union, later wins. Arrays concatenate with first-occurrence dedupe
 * (modules by id, edges by from+to+level, coupling by a+b, functions by
 * file+name+line).
 */
export function mergeSnapshots(meta: SnapshotMeta, parts: Partial<Snapshot>[]): Snapshot {
  const files = new Map<string, FileEntry>();
  const languages: Snapshot['languages'] = {};
  for (const p of parts) {
    Object.assign(languages, p.languages);
    for (const f of p.files ?? []) {
      const merged: Record<string, unknown> = { ...files.get(f.path) };
      for (const [k, v] of Object.entries(f)) if (v !== undefined) merged[k] = v;
      files.set(f.path, merged as unknown as FileEntry);
    }
  }
  const all = <T>(pick: (p: Partial<Snapshot>) => T[] | undefined): T[] =>
    parts.flatMap((p) => pick(p) ?? []);
  return {
    ...meta,
    languages,
    files: [...files.values()],
    functions: dedupe(all((p) => p.functions), (f) => `${f.file}\0${f.name}\0${f.line}`),
    modules: dedupe(all((p) => p.modules), (m) => m.id),
    edges: dedupe(all((p) => p.edges), (e) => `${e.from}\0${e.to}\0${e.level}`),
    coupling: dedupe(all((p) => p.coupling), (c) => `${c.a}\0${c.b}`),
  };
}
