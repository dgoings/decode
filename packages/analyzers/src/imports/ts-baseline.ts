// Baseline TS/JS resolver: Node-only, no compiler. Probes the tracked file set for
// relative specifiers, honors tsconfig `paths`/`baseUrl` (nearest tsconfig.json,
// following `extends`), and maps bare specifiers to their package name.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Resolution, Resolver } from './resolver.ts';

const EXT_PROBES = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_PROBES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
/** TS convention: a `.js`-style specifier may name a TS source. */
const SOURCE_FOR_EXT: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

interface TsPaths {
  /** Repo-relative dir that `baseUrl` points at, if set. */
  baseUrl?: string;
  paths?: Record<string, string[]>;
  /** Repo-relative dir of the config that defined `paths` (used when baseUrl is unset). */
  pathsDir?: string;
}

/** Parse JSON with comments and trailing commas (tsconfig flavour). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ',') {
      let j = i + 1;
      // Comments were not stripped ahead of us, so skip them while looking for a closer.
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text.startsWith('//', j)) j = text.indexOf('\n', j) < 0 ? text.length : text.indexOf('\n', j);
        else if (text.startsWith('/*', j)) j = text.indexOf('*/', j) < 0 ? text.length : text.indexOf('*/', j) + 2;
        else break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/**
 * Package name of a bare specifier, or undefined if it is not a valid one.
 * Runtime builtins keep their scheme (`node:fs`, `bun:test`); Deno-style
 * `npm:`/`jsr:` specifiers drop scheme and version; URL imports map to their host.
 */
export function packageName(spec: string): string | undefined {
  if (/^(node|bun):/.test(spec)) return spec.split('/')[0];
  const registry = /^(npm|jsr):\/?(.*)$/.exec(spec);
  if (registry) return packageName(registry[2].replace(/^(@?[^@/]+(?:\/[^@/]+)?)@[^/]*/, '$1'));
  if (/^https?:\/\//.test(spec)) {
    try {
      return new URL(spec).host;
    } catch {
      return undefined;
    }
  }
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return parts.length >= 2 && /^@[\w.-]+$/.test(parts[0]) && /^[\w.-]+$/.test(parts[1])
      ? `${parts[0]}/${parts[1]}`
      : undefined;
  }
  return /^[A-Za-z0-9][\w.-]*$/.test(parts[0]) ? parts[0] : undefined;
}

export function createBaselineTsResolver(root: string, files: string[]): Resolver {
  const fileSet = new Set(files);
  const tsconfigDirs = new Set(
    files.filter((f) => posix.basename(f) === 'tsconfig.json').map((f) => posix.dirname(f)),
  );
  const configCache = new Map<string, TsPaths>(); // by tsconfig path
  const dirConfig = new Map<string, TsPaths>(); // by source dir

  const readConfig = (rel: string, seen: Set<string>): TsPaths => {
    const cached = configCache.get(rel);
    if (cached) return cached;
    if (seen.has(rel)) return {};
    seen.add(rel);
    let json: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try {
      json = parseJsonc(readFileSync(join(root, rel), 'utf8')) as typeof json;
    } catch {
      return {};
    }
    const dir = posix.dirname(rel);
    let result: TsPaths = {};
    const parents = json.extends === undefined ? [] : [json.extends].flat();
    for (const ext of parents) {
      const parent = extendsPath(dir, ext);
      if (parent) result = { ...result, ...readConfig(parent, seen) };
    }
    const opts = json.compilerOptions ?? {};
    if (typeof opts.baseUrl === 'string') result.baseUrl = posix.join(dir, opts.baseUrl);
    if (opts.paths && typeof opts.paths === 'object') {
      result.paths = opts.paths;
      result.pathsDir = dir;
    }
    configCache.set(rel, result);
    return result;
  };

  const extendsPath = (dir: string, ext: string): string | undefined => {
    const withJson = ext.endsWith('.json') ? ext : `${ext}.json`;
    if (ext.startsWith('.')) return posix.join(dir, withJson);
    // Package config (e.g. "@tsconfig/node20/tsconfig.json"): only if installed under root.
    for (const cand of [`node_modules/${withJson}`, `node_modules/${ext}/tsconfig.json`]) {
      if (existsSync(join(root, cand))) return cand;
    }
    return undefined;
  };

  const configFor = (fromFile: string): TsPaths => {
    const start = posix.dirname(fromFile);
    const cached = dirConfig.get(start);
    if (cached) return cached;
    let dir = start;
    let cfg: TsPaths = {};
    for (;;) {
      if (tsconfigDirs.has(dir)) {
        cfg = readConfig(posix.join(dir, 'tsconfig.json'), new Set());
        break;
      }
      if (dir === '.') break;
      dir = posix.dirname(dir);
    }
    dirConfig.set(start, cfg);
    return cfg;
  };

  /** First tracked file the (repo-relative) base path can name. */
  const probe = (raw: string): string | undefined => {
    const base = posix.normalize(raw);
    if (base.startsWith('../') || base === '..' || base.startsWith('/')) return undefined;
    const cands: string[] = [];
    const ext = posix.extname(base);
    for (const src of SOURCE_FOR_EXT[ext] ?? []) cands.push(base.slice(0, -ext.length) + src);
    cands.push(base);
    for (const e of EXT_PROBES) cands.push(base + e);
    for (const idx of INDEX_PROBES) cands.push(posix.join(base, idx));
    return cands.find((c) => fileSet.has(c));
  };

  const file = (path: string | undefined): Resolution =>
    path ? { kind: 'file', path } : { kind: 'unresolved' };

  return {
    tier: 'baseline',
    resolve(fromFile, specifier) {
      const spec = specifier.split('?')[0];
      if (!spec) return { kind: 'unresolved' };
      if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
        return file(probe(posix.join(posix.dirname(fromFile), spec)));
      }
      if (spec.startsWith('/')) return { kind: 'unresolved' };

      const cfg = configFor(fromFile);
      if (cfg.paths) {
        const hit = matchPaths(cfg.paths, spec);
        if (hit) {
          const base = cfg.baseUrl ?? cfg.pathsDir ?? '.';
          for (const target of hit.targets) {
            const found = probe(posix.join(base, target.replace('*', hit.star)));
            if (found) return file(found);
          }
          return { kind: 'unresolved' };
        }
      }
      if (cfg.baseUrl) {
        const found = probe(posix.join(cfg.baseUrl, spec));
        if (found) return file(found);
      }
      const name = packageName(spec);
      return name ? { kind: 'external', name } : { kind: 'unresolved' };
    },
  };
}

/** TS `paths` matching: exact key wins, else the wildcard key with the longest prefix. */
function matchPaths(
  paths: Record<string, string[]>,
  spec: string,
): { targets: string[]; star: string } | undefined {
  if (Array.isArray(paths[spec]) && !spec.includes('*')) return { targets: paths[spec], star: '' };
  let best: { targets: string[]; star: string; prefix: number } | undefined;
  for (const [key, targets] of Object.entries(paths)) {
    const star = key.indexOf('*');
    if (star < 0 || !Array.isArray(targets)) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (spec.length < prefix.length + suffix.length) continue;
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (best && best.prefix >= prefix.length) continue;
    best = { targets, star: spec.slice(prefix.length, spec.length - suffix.length), prefix: prefix.length };
  }
  return best;
}
