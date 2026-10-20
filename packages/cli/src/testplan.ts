import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { extractUi, extractUiSync, hit, loadUiParsers, parseDiff, touchedUi, type LineRange, type UiFile, type UiFunction } from '@codeviz/analyzers';
import { detectEntryPoints, impactedScreens, implicitEdges, type PlanStep, type Snapshot, type TestPlan } from '@codeviz/core';
import { analyzeRef, type AnalyzeOptions } from './analyze.ts';
import { resolveRef } from './refs.ts';
import { buildSteps, type Resolver } from './steps.ts';

export interface TestPlanOptions extends AnalyzeOptions {
  /** An already-analyzed WORKTREE snapshot to use when head is `WORKTREE`. */
  worktree?: Snapshot | null;
  /** Globs (over repo paths) for files to treat as screens, on top of file-based routing. */
  entries?: string[];
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const execFileAsync = promisify(execFile);

/** Async so the server keeps serving while git runs. */
async function gitAsync(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

/**
 * Changed head-side files with their changed line ranges, and removed files, straight from one
 * `git diff` (not the metric diff). `WORKTREE` means `git diff <base>`: tracked files only, so a new file counts once staged.
 */
export async function changedRanges(root: string, baseSha: string, headSha: string): Promise<{ ranges: Map<string, LineRange[]>; deleted: string[] }> {
  const range = [baseSha, ...(headSha === 'WORKTREE' ? [] : [headSha])];
  const { ranges, deleted, renamed } = parseDiff(await gitAsync(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', ...range]));
  // Pure renames have no hunks; the moved file still counts as changed (whole file).
  for (const to of renamed) if (!ranges.has(to)) ranges.set(to, [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
  return { ranges, deleted };
}

/** Reads a working-tree file, or one commit's version synchronously (used by tests and `WORKTREE`); the server path batches with `readMany`. */
function readHead(root: string, headSha: string, file: string): string | null {
  try {
    return headSha === 'WORKTREE' ? readFileSync(join(root, file), 'utf8') : git(root, ['show', `${headSha}:${file}`]);
  } catch {
    return null;
  }
}

function catFileBatch(root: string, input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: root });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.stdin.end(input);
  });
}

/** Contents of many files at once: one `git cat-file --batch` process instead of one `git show` each. */
export async function readMany(root: string, headSha: string, files: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (headSha === 'WORKTREE' || !files.length) {
    for (const f of files) out.set(f, readHead(root, headSha, f));
    return out;
  }
  const buf = await catFileBatch(root, files.map((f) => `${headSha}:${f}\n`).join(''));
  let pos = 0;
  for (const f of files) {
    const eol = buf.indexOf(10, pos);
    if (eol < 0) break;
    const m = /^\S+ blob (\d+)$/.exec(buf.toString('utf8', pos, eol));
    if (!m) {
      out.set(f, null);
      pos = eol + 1;
      continue;
    }
    const size = Number(m[1]);
    out.set(f, buf.toString('utf8', eol + 1, eol + 1 + size));
    pos = eol + 1 + size + 1;
  }
  return out;
}

/** A line ending like this continues onto the next one (`=>`, an operator, an open bracket). */
const CONTINUES = /(=>|[=,(\[{?:&|*/<>]|(?<![+\-])[+\-])\s*$/;

/**
 * Resolver over a head snapshot's file list. Import specifiers are matched without running the
 * project's bundler: relative paths exactly, aliases (`@/x`, `~/x`, `src/x`) by path suffix.
 */
export function createResolver(
  files: string[],
  read: (file: string) => string | null,
  ranges: Map<string, LineRange[]>,
  /** Parsed function spans of a file; without it (or when it finds nothing) a text scan locates declarations. */
  spans?: (file: string, src: string) => UiFunction[],
): Resolver {
  const known = new Set(files);
  /** Path without extension -> file; `dir/index` also answers to `dir`, but never over a real `dir.ts`. */
  const byStem = new Map<string, string>();
  for (const f of files) {
    const stem = f.replace(/\.[^./]+$/, '');
    if (!byStem.has(stem)) byStem.set(stem, f);
  }
  for (const f of files) {
    const stem = f.replace(/\.[^./]+$/, '');
    if (stem.endsWith('/index') && !byStem.has(stem.slice(0, -'/index'.length))) byStem.set(stem.slice(0, -'/index'.length), f);
  }
  const suffixCache = new Map<string, string[]>();
  /** Files whose stem ends with `tail`; with several (a monorepo), the one sharing most of the importer's path. */
  const bySuffix = (tail: string, from: string): string | undefined => {
    let cands = suffixCache.get(tail);
    if (!cands) {
      cands = [];
      for (const [stem, f] of byStem) if (stem === tail || stem.endsWith(`/${tail}`)) cands.push(f);
      suffixCache.set(tail, cands);
    }
    const shared = (f: string): number => {
      const a = f.split('/');
      const b = from.split('/');
      let n = 0;
      while (n < a.length && n < b.length && a[n] === b[n]) n++;
      return n;
    };
    return cands.reduce<string | undefined>((best, f) => (best === undefined || shared(f) > shared(best) ? f : best), undefined);
  };
  const stripAlias = (spec: string): string | undefined => /^(?:[@~#]\/|src\/)(.+)$/.exec(spec)?.[1];

  function importFile(from: string, spec: string): string | undefined {
    if (spec.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(from), spec));
      // `./api.client` is a stem of its own; only fall back to stripping an extension for `./x.js` -> `x.ts`.
      return known.has(base) ? base : byStem.get(base) ?? byStem.get(base.replace(/\.[^./]+$/, ''));
    }
    const tail = stripAlias(spec);
    return tail ? bySuffix(tail, from) : undefined;
  }

  function apiModuleFile(from: string, spec: string, segments: string[]): string | undefined {
    const dirSpec = spec.replace(/\/_generated\/api(?:\.[cm]?js)?$/, '');
    const mod = segments.join('/');
    if (dirSpec.startsWith('.')) return byStem.get(posix.normalize(posix.join(posix.dirname(from), dirSpec, mod)));
    return bySuffix(`${stripAlias(dirSpec) ?? dirSpec}/${mod}`, from);
  }

  const spanCache = new Map<string, { line: number; endLine: number } | undefined>();
  const parsedCache = new Map<string, UiFunction[]>();
  const parsedFns = (file: string, src: string): UiFunction[] => {
    let fns = parsedCache.get(file);
    if (!fns) parsedCache.set(file, (fns = spans?.(file, src) ?? []));
    return fns;
  };
  function declSpan(file: string, name: string): { line: number; endLine: number } | undefined {
    const key = `${file}\0${name}`;
    if (spanCache.has(key)) return spanCache.get(key);
    const src = read(file);
    let span: { line: number; endLine: number } | undefined;
    const parsed = src !== null ? parsedFns(file, src).find((f) => f.name === name) : undefined;
    if (parsed) span = { line: parsed.line, endLine: parsed.endLine };
    else if (src !== null) {
      const lines = src.split('\n');
      const id = name.replace(/\$/g, '\\$');
      const strong = new RegExp(`(?:function\\*?\\s+${id}\\b|(?:const|let|var|class)\\s+${id}\\b)`);
      // Fallback for object members: `name(...) {`, `name:` and `name =`; never a plain call like `name(x);`.
      const weak = new RegExp(`^\\s*(?:async\\s+)?${id}\\s*(?:\\([^)]*\\)\\s*(?::[^{=]+)?\\{|:|=(?!=))`);
      let start = lines.findIndex((l) => strong.test(l));
      if (start < 0) start = lines.findIndex((l) => weak.test(l));
      if (start >= 0) {
        // The declaration ends at the first line where every bracket is closed and the line does not trail off.
        let depth = 0;
        let end = start;
        for (let i = start; i < Math.min(lines.length, start + 400); i++) {
          end = i;
          const code = lines[i]!.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
          for (const ch of code) depth = Math.max(0, depth + ('({['.includes(ch) ? 1 : ')}]'.includes(ch) ? -1 : 0));
          // `},` closing an object member is a separator, not a continuation.
          const trails = CONTINUES.test(code) && !(/,\s*$/.test(code) && /^\s*[})\]]/.test(code));
          if (depth <= 0 && !trails) break;
        }
        span = { line: start + 1, endLine: end + 1 };
      }
    }
    spanCache.set(key, span);
    return span;
  }

  function changed(file: string, from?: number, to?: number): boolean {
    const r = ranges.get(file);
    if (!r) return false;
    if (from === undefined) return true;
    const end = to ?? from;
    return r.some((x) => x.start <= end && from <= x.end);
  }

  return { importFile, apiModuleFile, declSpan, changed };
}

/** Innermost named functions (parsed spans) that overlap a changed range, for files with no UI of their own. */
function changedFunctionNames(ui: UiFile | null, ranges: LineRange[]): string[] {
  const hits = (ui?.functions ?? []).filter((f) => hit(ranges, f.line, f.endLine));
  const contains = (g: UiFunction, f: UiFunction): boolean => g !== f && f.line <= g.line && g.endLine <= f.endLine && (f.line < g.line || g.endLine < f.endLine);
  return [...new Set(hits.filter((f) => !hits.some((g) => contains(g, f))).map((f) => f.name))];
}

/** Analyze (or read from cache) both refs, then work out which screens the change affects and what to try on them. */
export async function buildTestPlan(root: string, base: string, head: string, opts: TestPlanOptions): Promise<TestPlan> {
  if (base === 'WORKTREE') throw new Error('WORKTREE can only be the head of a comparison, not the base');
  root = (await gitAsync(root, ['rev-parse', '--show-toplevel'])).trim();
  resolveRef(root, base);
  resolveRef(root, head);
  const { since, log, force } = opts;
  const b = (await analyzeRef(root, base, { since, log, force })).snapshot;
  const h = head === 'WORKTREE' && opts.worktree ? opts.worktree : (await analyzeRef(root, head, { since, log, force })).snapshot;

  await loadUiParsers();
  const { ranges, deleted } = await changedRanges(root, b.sha, h.sha);
  const headPaths = h.files.map((f) => f.path);
  const known = new Set(headPaths);
  const changed = [...ranges.keys()].filter((p) => known.has(p));

  const entries = detectEntryPoints(headPaths, opts.entries);
  const edges = [...h.edges, ...implicitEdges(headPaths, entries)];
  const impact = impactedScreens(edges, changed, entries);

  const text = await readMany(root, h.sha, changed);
  const uis = new Map<string, UiFile | null>();
  for (const file of changed) {
    const src = text.get(file);
    if (src === null || src === undefined) continue;
    try {
      uis.set(file, await extractUi(src, file));
    } catch {
      uis.set(file, null); // unparsable: such files fall through to the function-name steps
    }
  }

  /** One pass over the changed files. Files a callee lives in are read ahead of time, so a pass that finds new ones is run again. */
  const buildAll = (): { steps: Record<string, PlanStep[]>; missing: Set<string> } => {
    const missing = new Set<string>();
    const read = (file: string): string | null => {
      if (!text.has(file) && h.sha === 'WORKTREE') text.set(file, readHead(root, h.sha, file));
      if (text.has(file)) return text.get(file)!;
      missing.add(file);
      return null;
    };
    const resolver = createResolver(headPaths, read, ranges, (file, src) => {
      try {
        return extractUiSync(src, file)?.functions ?? [];
      } catch {
        return [];
      }
    });
    const steps: Record<string, PlanStep[]> = {};
    for (const file of changed) {
      if (!uis.has(file) && !text.get(file)) continue;
      const ui = uis.get(file) ?? null;
      const r = ranges.get(file)!;
      const found = buildSteps({
        file,
        ui: ui ?? { elements: [], components: [], functions: [], imports: {}, bindings: {} },
        touched: ui ? touchedUi(ui, r) : { elements: [], components: [] },
        ranges: r,
        fnNames: changedFunctionNames(ui, r),
        resolver,
      });
      if (found.length) steps[file] = found;
    }
    return { steps, missing };
  };
  let built = buildAll();
  for (let pass = 0; pass < 3 && built.missing.size; pass++) {
    for (const [file, src] of await readMany(root, h.sha, [...built.missing])) text.set(file, src);
    built = buildAll();
  }

  return {
    base: { sha: b.sha, ref: b.ref },
    head: { sha: h.sha, ref: h.ref },
    entries: entries.length,
    changed: changed.length,
    ignored: ranges.size - changed.length + deleted.length,
    impact,
    steps: built.steps,
  };
}
