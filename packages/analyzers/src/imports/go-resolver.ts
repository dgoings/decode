import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Resolution, Resolver } from './resolver.ts';

export interface GoModule {
  /** Module path declared in go.mod. */
  path: string;
  /** Repo-relative directory of the module ('' for the repo root). */
  dir: string;
}

export interface GoResolver extends Resolver {
  /** Modules found in the repo, longest path first. */
  modules: GoModule[];
  /** Package import path for a repo-relative .go file, or undefined when outside every module. */
  packageOf(file: string): string | undefined;
}

/** True for paths the go tool ignores: under vendor/, testdata/, or a directory starting with `_` or `.`. */
export function isGoIgnoredPath(file: string): boolean {
  const dirs = file.split('/').slice(0, -1);
  return dirs.some((d) => d === 'vendor' || d === 'testdata' || d.startsWith('_') || d.startsWith('.'));
}

function readModFile(root: string, rel: string): string | undefined {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return undefined;
  }
}

function unquote(s: string): string {
  return s.replace(/^(["`])(.*)\1$/, '$2');
}

/** Module path plus local-path replace directives (old module path -> target dir relative to the go.mod). */
export function parseGoMod(src: string): { module?: string; replaces: Array<{ from: string; to: string }> } {
  const lines = src.replace(/\/\/.*$/gm, '').split('\n').map((l) => l.trim());
  let module: string | undefined;
  const replaces: Array<{ from: string; to: string }> = [];
  let inReplace = false;
  for (const line of lines) {
    if (!line) continue;
    if (inReplace) {
      if (line === ')') inReplace = false;
      else addReplace(line);
      continue;
    }
    const m = /^module\s+(\S+)/.exec(line);
    if (m) module = unquote(m[1]!);
    else if (/^replace\s*\($/.test(line)) inReplace = true;
    else if (line.startsWith('replace ')) addReplace(line.slice('replace '.length));
  }
  return { module, replaces };

  function addReplace(spec: string): void {
    const [lhs, rhs] = spec.split('=>').map((s) => s.trim());
    if (!lhs || !rhs) return;
    const from = unquote(lhs.split(/\s+/)[0]!);
    const to = unquote(rhs.split(/\s+/)[0]!);
    // Only local paths (./ ../ or absolute) map into the repo; versioned replacements are external.
    if (to.startsWith('./') || to.startsWith('../')) replaces.push({ from, to });
  }
}

/** Package name for an external import: stdlib's first segment, else host/org/repo. */
function externalName(spec: string): string {
  const parts = spec.split('/');
  if (!parts[0]!.includes('.')) return parts[0]!;
  return parts.slice(0, 3).join('/');
}

/**
 * Baseline Go resolver: maps import paths to in-repo packages using go.mod module
 * paths (root and nested) and local replace directives; stdlib and everything else
 * is external. `files` are repo-relative tracked paths.
 */
export function createGoResolver(root: string, files: string[]): GoResolver {
  const pkgDirs = new Set<string>();
  for (const f of files) if (f.endsWith('.go') && !isGoIgnoredPath(f)) pkgDirs.add(dirOf(f));

  const byPath = new Map<string, string>();
  for (const f of files) {
    if ((f !== 'go.mod' && !f.endsWith('/go.mod')) || isGoIgnoredPath(f)) continue;
    const src = readModFile(root, f);
    if (src === undefined) continue;
    const dir = dirOf(f);
    const mod = parseGoMod(src);
    if (mod.module) byPath.set(mod.module, dir);
    for (const r of mod.replaces) {
      const target = posix.normalize(posix.join(dir || '.', r.to));
      if (target.startsWith('..')) continue;
      if (!byPath.has(r.from)) byPath.set(r.from, target === '.' ? '' : target);
    }
  }
  const modules: GoModule[] = [...byPath]
    .map(([path, dir]) => ({ path, dir }))
    .sort((a, b) => b.path.length - a.path.length);
  // For packageOf: the deepest module directory containing the file.
  const byDir = [...modules].filter((m, i, a) => a.findIndex((n) => n.dir === m.dir) === i).sort((a, b) => b.dir.length - a.dir.length);

  return {
    tier: 'baseline',
    modules,
    resolve(_fromFile: string, spec: string): Resolution {
      for (const m of modules) {
        if (spec !== m.path && !spec.startsWith(m.path + '/')) continue;
        const sub = spec.slice(m.path.length + 1);
        const dir = m.dir && sub ? `${m.dir}/${sub}` : m.dir || sub;
        // Canonical id comes from the module that owns the directory (a replace alias maps to it).
        return pkgDirs.has(dir) ? { kind: 'module', id: pkgIdForDir(dir) ?? spec } : { kind: 'unresolved' };
      }
      return { kind: 'external', name: externalName(spec) };
    },
    packageOf: (file) => pkgIdForDir(dirOf(file)),
  };

  function pkgIdForDir(dir: string): string | undefined {
    for (const m of byDir) {
      if (m.dir === '') return dir ? `${m.path}/${dir}` : m.path;
      if (dir === m.dir) return m.path;
      if (dir.startsWith(m.dir + '/')) return `${m.path}/${dir.slice(m.dir.length + 1)}`;
    }
    return undefined;
  }
}

function dirOf(f: string): string {
  const d = posix.dirname(f);
  return d === '.' ? '' : d;
}
