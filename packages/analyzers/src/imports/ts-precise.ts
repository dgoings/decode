// Precise TS tier: resolves imports with the analyzed repo's own typescript and tsconfig.
// typescript is loaded at runtime from the repo (type-only import here; never bundled).
import type * as TS from 'typescript';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Resolution, Resolver } from './resolver.ts';

export interface FoundTypescript { modulePath: string; version: string; source: 'checkout' | 'head-reuse' }

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function major(v: string): number | null {
  const m = /^\d+/.exec(v);
  return m ? Number(m[0]) : null;
}

/** Major of a declared semver range: `^5.6.0`, `~5.4`, `5.x`, `5.6.3`. Anything else -> null. */
function rangeMajor(range: string): number | null {
  const m = /^[\^~]?\s*(\d+)(?:\.(?:\d+|x|\*)){0,2}(?:-[\w.]+)?$/.exec(range.trim());
  return m ? Number(m[1]) : null;
}

export function findTypescript(root: string, headRoot: string): FoundTypescript | null {
  const local = join(root, 'node_modules', 'typescript', 'package.json');
  const localPkg = existsSync(local) ? readJson(local) : null;
  if (localPkg && typeof localPkg.version === 'string') {
    return { modulePath: dirname(local), version: localPkg.version, source: 'checkout' };
  }
  const head = join(headRoot, 'node_modules', 'typescript', 'package.json');
  const headPkg = existsSync(head) ? readJson(head) : null;
  if (!headPkg || typeof headPkg.version !== 'string') return null;
  const rootPkg = readJson(join(root, 'package.json'));
  const deps = { ...(rootPkg?.dependencies as object), ...(rootPkg?.devDependencies as object) } as Record<string, unknown>;
  const declared = deps.typescript;
  if (typeof declared !== 'string') return null;
  const want = rangeMajor(declared);
  if (want === null || want !== major(headPkg.version)) return null;
  return { modulePath: dirname(head), version: headPkg.version, source: 'head-reuse' };
}

const builtins = new Set(builtinModules);

function packageNameFromPath(p: string): string {
  const parts = p.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  const rest = parts.slice(i + 1);
  return rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0] ?? p;
}

/** `@types/react` -> `react`, `@types/scope__pkg` -> `@scope/pkg`. */
function untyped(name: string): string {
  if (!name.startsWith('@types/')) return name;
  const n = name.slice('@types/'.length);
  return n.includes('__') ? `@${n.replace('__', '/')}` : n;
}

function packageNameFromSpecifier(s: string): string {
  const parts = s.split('/');
  return s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function matchesPathAlias(spec: string, paths: TS.MapLike<string[]> | undefined): boolean {
  return Object.keys(paths ?? {}).some((k) => {
    const star = k.indexOf('*');
    return star < 0 ? spec === k : spec.startsWith(k.slice(0, star)) && spec.endsWith(k.slice(star + 1));
  });
}

interface Project { options: TS.CompilerOptions; files: Set<string>; cache: TS.ModuleResolutionCache }

export function createPreciseTsResolver(root: string, ts: { modulePath: string }, files: string[]): Resolver {
  const t = createRequire(import.meta.url)(ts.modulePath) as typeof TS;
  const absRoot = resolve(root);
  const realRoot = realpathSync(absRoot);
  const tracked = new Set(files);

  const makeProject = (options: TS.CompilerOptions, fileNames: string[]): Project => ({
    options,
    files: new Set(fileNames.map((f) => resolve(f))),
    cache: t.createModuleResolutionCache(absRoot, (f) => f, options),
  });

  // Root tsconfig plus (one level of) project references, so a solution-style
  // tsconfig still gets each sub-project's paths/baseUrl.
  const projects: Project[] = [];
  const configPath = t.findConfigFile(absRoot, t.sys.fileExists);
  if (configPath) {
    const seen = new Set<string>();
    const load = (path: string, depth: number) => {
      if (seen.has(path)) return;
      seen.add(path);
      const raw = t.readConfigFile(path, t.sys.readFile);
      if (raw.error) throw new Error(`cannot read ${path}: ${t.flattenDiagnosticMessageText(raw.error.messageText, '\n')}`);
      const parsed = t.parseJsonConfigFileContent(raw.config, t.sys, dirname(path), undefined, path);
      projects.push(makeProject(parsed.options, parsed.fileNames));
      if (depth > 0) {
        for (const ref of parsed.projectReferences ?? []) {
          const p = t.resolveProjectReferencePath(ref);
          if (t.sys.fileExists(p)) load(p, depth - 1);
        }
      }
    };
    load(configPath, 2);
  } else {
    const K = t.ModuleResolutionKind as unknown as Record<string, number | undefined>;
    projects.push(makeProject({
      moduleResolution: (K.Bundler ?? K.NodeNext ?? K.NodeJs) as TS.ModuleResolutionKind,
      module: t.ModuleKind.ESNext,
      target: t.ScriptTarget.ES2022,
      allowJs: true,
      resolveJsonModule: true,
      jsx: t.JsxEmit.ReactJSX,
    }, []));
  }
  // Prefer a project that owns the file; otherwise the root config.
  const projectFor = (abs: string): Project => projects.find((p) => p.files.has(abs)) ?? projects[0]!;

  const toRepoPath = (abs: string): string | null => {
    for (const base of [absRoot, realRoot]) {
      const rel = relative(base, abs);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
    return null;
  };

  return {
    tier: 'precise',
    resolve(fromFile: string, specifier: string): Resolution {
      if (specifier.startsWith('node:') || builtins.has(specifier)) return { kind: 'external', name: specifier };
      const absFrom = join(absRoot, fromFile);
      const proj = projectFor(absFrom);
      let mod: TS.ResolvedModuleFull | undefined;
      try {
        mod = t.resolveModuleName(specifier, absFrom, proj.options, t.sys, proj.cache).resolvedModule;
      } catch {
        return { kind: 'unresolved' };
      }
      if (!mod) {
        // A bare specifier tsc cannot type (e.g. an untyped JS package) is still an
        // external package, unless it looks like a path alias that failed to map.
        const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#');
        return bare && !matchesPathAlias(specifier, proj.options.paths)
          ? { kind: 'external', name: packageNameFromSpecifier(specifier) }
          : { kind: 'unresolved' };
      }
      const file = mod.resolvedFileName;
      if (mod.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(file)) {
        return { kind: 'external', name: untyped(mod.packageId?.name ?? packageNameFromPath(file)) };
      }
      const rel = toRepoPath(file);
      if (!rel) return { kind: 'unresolved' };
      if (rel.endsWith('.d.ts')) {
        const base = rel.slice(0, -'.d.ts'.length);
        for (const ext of ['.ts', '.tsx']) if (tracked.has(base + ext)) return { kind: 'file', path: base + ext };
      }
      return { kind: 'file', path: rel };
    },
  };
}

export function pickTsResolver(opts: {
  root: string;
  headRoot: string;
  files: string[];
  baseline: () => Resolver;
  log?: (s: string) => void;
}): Resolver {
  const log = opts.log ?? (() => {});
  try {
    const found = findTypescript(opts.root, opts.headRoot);
    if (!found) {
      const headTs = readJson(join(opts.headRoot, 'node_modules', 'typescript', 'package.json'))?.version;
      const pkg = readJson(join(opts.root, 'package.json'));
      const declared = (pkg?.devDependencies as Record<string, unknown> | undefined)?.typescript
        ?? (pkg?.dependencies as Record<string, unknown> | undefined)?.typescript;
      const why = !headTs ? 'typescript is not installed in the checkout or HEAD'
        : declared === undefined ? `package.json does not declare typescript (HEAD has ${headTs})`
        : `package.json wants typescript ${String(declared)}, HEAD has ${headTs} (incompatible major)`;
      log(`ts: ${why}; using baseline resolver`);
      return opts.baseline();
    }
    const r = createPreciseTsResolver(opts.root, found, opts.files);
    log(`ts: precise resolver via typescript ${found.version} (${found.source}: ${found.modulePath})`);
    return r;
  } catch (e) {
    log(`ts: precise resolver failed (${e instanceof Error ? e.message : String(e)}); using baseline resolver`);
    return opts.baseline();
  }
}
