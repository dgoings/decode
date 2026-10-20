import type { EdgeEntry } from './snapshot.ts';

/** A screen: a file the router renders as its own page. */
export interface EntryPoint {
  path: string;
  /** URL path, e.g. `/users/:id`. For `--entry` overrides this is the file path. */
  route: string;
}

const CODE = /\.(tsx|jsx|ts|js)$/;
const JSX_FILE = /\.[jt]sx$/;
const NOT_SCREEN = /(\.d\.ts$|\.(test|spec|stories)\.[jt]sx?$|(^|\/)__tests__\/)/;

/** `[id]` -> `:id`, `[...slug]` -> `*`, `[[...slug]]` -> `*`. */
function bracketSegment(seg: string): string {
  const m = /^\[\[?(\.\.\.)?([^\]]*)\]\]?$/.exec(seg);
  if (!m) return seg;
  return m[1] ? '*' : `:${m[2]}`;
}

const joinRoute = (segs: string[]): string => '/' + segs.filter((s) => s !== '').join('/');

/** Route for a file in a Next.js pages router, or null when the file is not a page. */
/** `pages/` only counts at a project root (`pages/`, `src/pages/`, `apps/web/src/pages/`), not as any nested folder name. */
const PAGES_DIR = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?pages\/(.+)$/;
const ROUTES_DIR = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/|app\/)?routes\/(.+)$/;

function pagesRoute(path: string): string | null {
  const m = PAGES_DIR.exec(path);
  if (!m || !JSX_FILE.test(path)) return null;
  const segs = m[1]!.replace(CODE, '').split('/');
  if (segs[0] === 'api') return null;
  if (segs[segs.length - 1]!.startsWith('_')) return null; // _app, _document, _error
  if (segs[segs.length - 1] === 'index') segs.pop();
  return joinRoute(segs.map(bracketSegment));
}

/** Route for a Next.js app-router `page` file, or null. Route groups `(x)` and slots `@x` are dropped. */
function appRoute(path: string): string | null {
  const m = /(?:^|\/)app\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js)$/.exec(path);
  if (!m) return null;
  const segs = (m[1] ?? '').split('/').filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  return joinRoute(segs.map(bracketSegment));
}

/** Route for a Remix / TanStack-style `routes/` file (flat dots or nested folders), or null. `__root` is the root layout, not a screen. */
function routesRoute(path: string): string | null {
  const m = ROUTES_DIR.exec(path);
  if (!m || !JSX_FILE.test(path) || /^__root\.[jt]sx?$/.test(m[1]!)) return null;
  let segs = m[1]!
    .replace(CODE, '')
    .split(/[./]/);
  // A last segment like `_auth` is a pathless layout wrapping other routes, not a screen.
  const last = segs[segs.length - 1]!;
  if (last.startsWith('_') && last !== '_index') return null;
  segs = segs.filter((s) => s !== 'index' && s !== '_index' && !s.startsWith('_'));
  if (segs[segs.length - 1] === 'route') segs.pop(); // folder convention: `users.$id/route.tsx`
  return joinRoute(segs.map((s) => (s === '$' ? '*' : s.startsWith('$') ? `:${s.slice(1).replace(/_+$/, '')}` : s.replace(/_+$/, ''))));
}

type GlobToken = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'globstar' } | { t: 'dirs' };

export interface Glob {
  test(path: string): boolean;
}

/**
 * Compile a `*` / `?` / `**` glob over forward-slash paths. Matching is memoized per (token, position),
 * so it is O(pattern x path) however many wildcards a pattern has; a regex would backtrack exponentially.
 */
export function compileGlob(glob: string): Glob {
  if (glob.length > 200) throw new Error(`glob is too long (max 200 chars): ${glob.slice(0, 40)}`);
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        tokens.push({ t: 'dirs' }); // `**/`: any number of whole directories
      } else tokens.push({ t: 'globstar' });
    } else if (c === '*') tokens.push({ t: 'star' });
    else if (c === '?') tokens.push({ t: 'one' });
    else tokens.push({ t: 'lit', c });
  }
  return {
    test(path) {
      const n = path.length;
      const memo = new Map<number, boolean>();
      const match = (i: number, j: number): boolean => {
        const key = i * (n + 1) + j;
        const known = memo.get(key);
        if (known !== undefined) return known;
        const tok = tokens[i];
        let ok: boolean;
        if (!tok) ok = j === n;
        else if (tok.t === 'lit') ok = j < n && path[j] === tok.c && match(i + 1, j + 1);
        else if (tok.t === 'one') ok = j < n && path[j] !== '/' && match(i + 1, j + 1);
        else if (tok.t === 'star') ok = match(i + 1, j) || (j < n && path[j] !== '/' && match(i, j + 1));
        else if (tok.t === 'globstar') ok = match(i + 1, j) || (j < n && match(i, j + 1));
        else {
          const slash = path.indexOf('/', j);
          ok = match(i + 1, j) || (slash >= 0 && match(i, slash + 1));
        }
        memo.set(key, ok);
        return ok;
      };
      return match(0, 0);
    },
  };
}

/**
 * Screens among `paths`: files that match a file-based routing convention (Next.js pages and app
 * routers, Remix-style `routes/`), plus every file matching an `overrides` glob. Overrides win,
 * and use the file path as the route.
 */
export function detectEntryPoints(paths: string[], overrides: string[] = []): EntryPoint[] {
  const over = overrides.map(compileGlob);
  const out: EntryPoint[] = [];
  for (const path of paths) {
    if (!CODE.test(path) || NOT_SCREEN.test(path)) continue;
    if (over.some((re) => re.test(path))) {
      out.push({ path, route: path });
      continue;
    }
    const route = appRoute(path) ?? pagesRoute(path) ?? routesRoute(path);
    if (route !== null) out.push({ path, route });
  }
  return out.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.path < b.path ? -1 : 1));
}

/**
 * Imports the graph cannot see: app-router pages sit inside their `layout`/`template` files,
 * pages-router pages inside `_app`, `routes/` screens inside `__root`. Returned as `page -> layout` edges.
 */
export function implicitEdges(paths: string[], entries: EntryPoint[]): EdgeEntry[] {
  const set = new Set(paths);
  const edges: EdgeEntry[] = [];
  for (const e of entries) {
    const app = /^(.*?(?:^|\/)app)\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js)$/.exec(e.path);
    if (app) {
      const dirs = (app[2] ?? '').split('/').filter((s) => s !== '');
      for (let i = 0; i <= dirs.length; i++) {
        const dir = [app[1]!, ...dirs.slice(0, i)].join('/');
        for (const name of ['layout', 'template']) {
          for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
            const layout = `${dir}/${name}.${ext}`;
            if (set.has(layout)) edges.push({ from: e.path, to: layout, kind: 'implicit', level: 'file' });
          }
        }
      }
      continue;
    }
    const routes = /^(.*?(?:^|\/)routes)\//.exec(e.path);
    if (routes) {
      for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
        const root = `${routes[1]}/__root.${ext}`;
        if (set.has(root)) edges.push({ from: e.path, to: root, kind: 'implicit', level: 'file' });
      }
      continue;
    }
    const pages = /^(.*?(?:^|\/)pages)\//.exec(e.path);
    if (pages) {
      for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
        const appFile = `${pages[1]}/_app.${ext}`;
        if (set.has(appFile)) edges.push({ from: e.path, to: appFile, kind: 'implicit', level: 'file' });
      }
    }
  }
  return edges;
}

/** A changed file reachable from a screen, with the shortest import chain from the screen to it. */
export interface Reach {
  file: string;
  /** Import hops from the screen's file; 0 when the screen file itself changed. */
  hops: number;
  /** Screen file first, changed file last. */
  chain: string[];
  /** Changed file that reaches many screens (design-system code, utilities): low signal per screen. */
  shared: boolean;
}

export interface ImpactedScreen {
  entry: EntryPoint;
  /** Nearest first. */
  reached: Reach[];
  /** Fewest hops among reached files that are not shared; null when every reached file is shared. */
  nearest: number | null;
}

export interface Impact {
  /** Riskiest first: screens reaching a non-shared changed file, nearest chain, then most files. */
  screens: ImpactedScreen[];
  /** Changed files that reach at least `sharedThreshold` screens, most widespread first. */
  shared: Array<{ file: string; screens: number }>;
  /** Changed files that no screen reaches (tests, config, server code, unused files). */
  unreached: string[];
}

/**
 * Screens worth their own section: those a screen-specific changed file reaches. A screen reached only
 * through shared code (a nav bar, a design-system component) is covered by `impact.shared` instead.
 */
export const specificScreens = (impact: Impact): ImpactedScreen[] => impact.screens.filter((s) => s.nearest !== null);

export interface ImpactOptions {
  /** A changed file reaching this many screens counts as shared (default 5). */
  sharedThreshold?: number;
}

/**
 * Which screens a change affects: each screen's transitive file imports (never into another screen),
 * with the shortest chain to each changed file it meets. `changed` comes from `git diff`, not the
 * metric-based snapshot diff, which misses edits that keep size and complexity the same.
 */
export function impactedScreens(
  edges: EdgeEntry[],
  changed: string[],
  entries: EntryPoint[],
  opts: ImpactOptions = {},
): Impact {
  // Shared once a file reaches most of a small app's screens, or 5 in a large one.
  const threshold = opts.sharedThreshold ?? Math.max(3, Math.min(5, Math.ceil(entries.length * 0.6)));
  const changedSet = new Set(changed);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.level !== 'file') continue;
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }

  const entryPaths = new Set(entries.map((e) => e.path));
  const raw = entries.map((entry) => {
    // BFS from the screen file; parent pointers rebuild the shortest chain.
    const parent = new Map<string, string | null>([[entry.path, null]]);
    const hops = new Map<string, number>([[entry.path, 0]]);
    const queue = [entry.path];
    const found: Array<{ file: string; hops: number }> = [];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      if (changedSet.has(cur)) found.push({ file: cur, hops: hops.get(cur)! });
      for (const next of adj.get(cur) ?? []) {
        if (parent.has(next)) continue;
        // Another screen is not part of this one. Without this, a router manifest (routeTree.gen.ts
        // importing every route) makes every screen "reach" every other screen's files.
        if (entryPaths.has(next) && next !== entry.path) continue;
        parent.set(next, cur);
        hops.set(next, hops.get(cur)! + 1);
        queue.push(next);
      }
    }
    const chainTo = (file: string): string[] => {
      const chain: string[] = [];
      for (let p: string | null | undefined = file; p; p = parent.get(p)) chain.push(p);
      return chain.reverse();
    };
    return { entry, found, chainTo };
  });

  const fanOut = new Map<string, number>();
  for (const r of raw) for (const f of r.found) fanOut.set(f.file, (fanOut.get(f.file) ?? 0) + 1);
  const isShared = (file: string) => (fanOut.get(file) ?? 0) >= threshold;

  const screens: ImpactedScreen[] = raw
    .filter((r) => r.found.length > 0)
    .map((r) => {
      const reached: Reach[] = r.found.map((f) => ({
        file: f.file,
        hops: f.hops,
        chain: r.chainTo(f.file),
        shared: isShared(f.file),
      }));
      const local = reached.filter((x) => !x.shared);
      return { entry: r.entry, reached, nearest: local.length ? local[0]!.hops : null };
    });
  screens.sort(
    (a, b) =>
      Number(a.nearest === null) - Number(b.nearest === null) ||
      (a.nearest ?? 0) - (b.nearest ?? 0) ||
      b.reached.length - a.reached.length ||
      (a.entry.route < b.entry.route ? -1 : a.entry.route > b.entry.route ? 1 : 0),
  );

  return {
    screens,
    shared: [...fanOut]
      .filter(([file]) => isShared(file))
      .map(([file, n]) => ({ file, screens: n }))
      .sort((a, b) => b.screens - a.screens || (a.file < b.file ? -1 : 1)),
    unreached: changed.filter((f) => !fanOut.has(f)).sort(),
  };
}

export type StepKind = 'click' | 'enter' | 'submit' | 'open' | 'state' | 'view' | 'logic';

export type FlowNodeKind = 'element' | 'handler' | 'call' | 'state' | 'condition' | 'component' | 'screen';

/** One box in a step's flow graph: something that runs or renders when the user takes the step. */
export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  /** Short, readable: `"Add tag" button`, `onAdd`, `taskTags.create`, `tags === undefined`. */
  label: string;
  file?: string;
  line?: number;
  /** The diff touches this node's code. */
  changed?: boolean;
}

/** What the step exercises, as a graph read top to bottom (edges are `[from, to]` node ids). */
export interface Flow {
  nodes: FlowNode[];
  edges: Array<[string, string]>;
}

/** One thing to try by hand, written from the user's side, derived from a changed line. */
export interface PlanStep {
  kind: StepKind;
  /** Where on the screen, in the user's words: `Tags settings section`. */
  area: string;
  /** What to do: `Click "Add tag"`. Backticks mark code. */
  text: string;
  /** What to look for afterwards. */
  checks: string[];
  /** How to get the app into the right state, when that is not obvious. */
  how?: string;
  /** What changed in the code, for the reviewer (one line each). */
  why: string[];
  file: string;
  line: number;
  flow: Flow;
}

export interface TestPlan {
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  /** Screens found (file routes plus `--entry` overrides). Zero means routes could not be detected. */
  entries: number;
  /** Changed files the analysis knows about (code files in head). */
  changed: number;
  /** Changed files that are not analyzed code (docs, styles, assets, removed files). */
  ignored: number;
  impact: Impact;
  /** Steps for each changed file that has any, keyed by path. */
  steps: Record<string, PlanStep[]>;
}

