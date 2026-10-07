import { posix } from 'node:path';
import type { EdgeEntry, ModuleEntry } from '@codeviz/core';
import type { RawImport, Resolver } from './resolver.ts';

export interface FileGraph {
  modules: ModuleEntry[];
  edges: EdgeEntry[];
  /** Specifiers the resolver could not place. */
  unresolved: number;
  /** External package name -> number of import sites. */
  externals: Record<string, number>;
}

/**
 * Resolve raw imports into file-level edges and directory modules. `files` are the
 * analyzed files: edges only connect analyzed files (imports of e.g. CSS or JSON
 * resolve but produce no edge), and each directory holding one becomes a module.
 */
export function buildFileGraph(raw: RawImport[], resolver: Resolver, files: string[]): FileGraph {
  const analyzed = new Set(files);
  const edgeKeys = new Set<string>();
  const edges: EdgeEntry[] = [];
  const externals: Record<string, number> = {};
  let unresolved = 0;

  for (const imp of raw) {
    const r = resolver.resolve(imp.file, imp.specifier);
    if (r.kind === 'unresolved') unresolved++;
    else if (r.kind === 'external') externals[r.name] = (externals[r.name] ?? 0) + 1;
    else if (r.kind === 'file') {
      if (r.path === imp.file || !analyzed.has(imp.file) || !analyzed.has(r.path)) continue;
      const key = `${imp.file}\0${r.path}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: imp.file, to: r.path, kind: 'import', level: 'file' });
    }
  }

  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = posix.dirname(f);
    let list = byDir.get(dir);
    if (!list) byDir.set(dir, (list = []));
    list.push(f);
  }
  const modules: ModuleEntry[] = [...byDir.keys()]
    .sort()
    .map((id) => ({ id, kind: 'dir' as const, files: byDir.get(id)! }));

  return { modules, edges, unresolved, externals };
}
