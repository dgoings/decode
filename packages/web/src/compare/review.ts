// "Look here first": ranks a comparison's changed files by review risk, with plain-language reasons (no DOM).
import type { FileDelta, Snapshot, SnapshotDiff } from '@codeviz/core';

export type SignalKind = 'complexity' | 'cycle' | 'boundary' | 'fan-in' | 'hotspot' | 'co-change' | 'tests';
export type Level = 'high' | 'medium' | 'low' | 'none';

export interface Signal {
  kind: SignalKind;
  /** Contribution to the file's score; higher is riskier. */
  weight: number;
  /** What happened, specific to this file. */
  title: string;
  /** A few words for the collapsed row. */
  short: string;
  /** Why a reviewer cares (the teaching line). */
  why: string;
  /** A question to ask in review. */
  ask: string;
}

export interface ReviewItem {
  path: string;
  status: FileDelta['status'];
  /** Net code-line delta. */
  code: number;
  score: number;
  level: Level;
  signals: Signal[];
}

export interface ReviewOptions {
  /** Function complexity at or above this is flagged when it grows. */
  complexityHigh?: number;
  /** Importer count at or above this is flagged as a wide blast radius. */
  fanInHigh?: number;
  /** Co-change count at or above this, and at least `coChangeShare` of the file's commits, counts as "usually change together". */
  coChangeMin?: number;
  coChangeShare?: number;
  /** A modified function must gain at least this much complexity to be flagged. */
  complexityStep?: number;
  /** Net code-line delta at or above this adds a point to the score. */
  largeChange?: number;
}

const DEFAULTS: Required<ReviewOptions> = { complexityHigh: 10, fanInHigh: 8, coChangeMin: 3, coChangeShare: 0.4, complexityStep: 3, largeChange: 300 };

const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.go$)|(^|\/)(__tests__|test|tests)\//;
export const isTestPath = (p: string): boolean => TEST_RE.test(p);

/** Likely test files for a source file: foo.ts -> foo.test.ts / foo.spec.ts; foo.go -> foo_test.go. */
export function testCandidates(path: string): string[] {
  const m = /^(.*)\.([cm]?[jt]sx?)$/.exec(path);
  if (m) return [`${m[1]}.test.${m[2]}`, `${m[1]}.spec.${m[2]}`];
  if (path.endsWith('.go')) return [`${path.slice(0, -3)}_test.go`];
  return [];
}

/** Top-level area of a path: `packages/web/...` -> `packages/web`, `src/x.ts` -> `src`. */
export function areaOf(path: string): string {
  const parts = path.split('/');
  if (parts.length > 2 && ['packages', 'apps', 'libs', 'services', 'modules'].includes(parts[0]!)) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0]! : '.';
}

/** Value at the given quantile (0..1) of a list of numbers, or Infinity when empty. */
function quantile(values: number[], q: number): number {
  if (!values.length) return Infinity;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** True when `to` can reach `from` through file edges, i.e. the edge from -> to closes a cycle. */
function closesCycle(adj: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([to]);
  const queue = [to];
  while (queue.length) {
    const v = queue.shift()!;
    if (v === from) return true;
    for (const w of adj.get(v) ?? []) if (!seen.has(w)) seen.add(w), queue.push(w);
  }
  return false;
}

/** Lead-ins for kinds whose per-item titles are fragments that get listed together. */
const LISTED: Partial<Record<SignalKind, (n: number) => string>> = {
  complexity: (n) => (n === 1 ? 'Function got complex: ' : `${n} functions got complex: `),
  'co-change': () => 'Usually changes with ',
};
const LIST_SUFFIX: Partial<Record<SignalKind, string>> = { 'co-change': ', untouched here' };

/**
 * One signal per kind, so a card shows each why/ask once. Weight is the strongest item plus one
 * per extra item (capped); titles are listed strongest first.
 */
function mergeByKind(signals: Signal[]): Signal[] {
  const byKind = new Map<SignalKind, Signal[]>();
  for (const s of signals) {
    const list = byKind.get(s.kind);
    if (list) list.push(s);
    else byKind.set(s.kind, [s]);
  }
  return [...byKind].map(([kind, list]) => {
    // Strongest first; on ties a grown function (its short has an arrow) leads the new ones.
    list.sort((a, b) => b.weight - a.weight || Number(b.short.includes('→')) - Number(a.short.includes('→')));
    const lead = LISTED[kind];
    const shown = list.slice(0, 4).map((s) => s.title);
    const more = list.length > 4 ? `, +${list.length - 4} more` : '';
    const title = lead ? `${lead(list.length)}${shown.join(', ')}${more}${LIST_SUFFIX[kind] ?? ''}` : shown.join('; ') + more;
    const ask = kind === 'co-change' && list.length > 1 ? 'Do any of these need a matching change?' : list[0]!.ask;
    const grown = list.find((x) => x.short.includes('→'));
    const short =
      kind === 'co-change' && list.length > 1 ? `${list.length} usual partners not updated` : kind === 'complexity' && grown ? grown.short : list[0]!.short;
    // More of the same kind adds a little: many complex functions are one problem, not five.
    const extra = Math.min(kind === 'complexity' ? 1 : 2, list.length - 1);
    return { ...list[0]!, weight: list[0]!.weight + extra, title, ask, short };
  });
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Score bands: one strong signal (a cycle, a big complexity jump) or two medium ones is `high`. */
export const levelOf = (score: number): Level => (score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'none');

/** Display name for a function; anonymous ones get their line in head (matched by complexity). */
function fnLabel(head: Snapshot, file: string, name: string, complexity: number): string {
  if (name !== '<anonymous>') return `\`${name}\``;
  const line = head.functions.find((f) => f.file === file && f.name === name && f.complexity === complexity)?.line;
  return line ? `anonymous function at line ${line}` : 'an anonymous function';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Changed files ranked by review risk. Every signal comes from data the diff and head snapshot
 * already carry: function complexity deltas, added edges, import fan-in, churn, co-change history
 * and test-file presence. Files with no signals are kept at the bottom so the list covers the
 * whole change.
 */
export function reviewItems(diff: SnapshotDiff, head: Snapshot, options: ReviewOptions = {}): ReviewItem[] {
  const o = { ...DEFAULTS, ...options };
  const changed = diff.files.filter((d) => d.status !== 'unchanged');
  const changedSet = new Set(changed.map((d) => d.path));
  const headPaths = new Set(head.files.map((f) => f.path));
  const signals = new Map<string, Signal[]>(changed.map((d) => [d.path, []]));
  const add = (path: string, s: Signal) => signals.get(path)?.push(s);

  // Complexity: functions that got (or arrived) complex.
  for (const fn of diff.functions) {
    const hc = fn.headComplexity ?? 0;
    if (hc < o.complexityHigh || fn.complexity <= 0) continue;
    if (fn.status === 'modified' && fn.complexity < o.complexityStep) continue;
    const name = fnLabel(head, fn.file, fn.name, hc);
    const title = fn.status === 'added' ? `new ${name} (${hc})` : `${name} ${fn.baseComplexity} → ${hc}`;
    // An existing function getting worse counts for more than the same complexity arriving new:
    // new code is read in full anyway, a grown function hides its new branches among old ones.
    const weight =
      fn.status === 'added'
        ? 1 + Math.min(3, Math.floor(hc / o.complexityHigh))
        : 2 + Math.min(4, Math.max(Math.floor(hc / 20), Math.floor(fn.complexity / 5)));
    add(fn.file, {
      kind: 'complexity',
      weight,
      title,
      short: fn.status === 'added' ? 'complex new functions' : `complexity ${fn.baseComplexity}→${hc}`,
      why: 'Each branch is a path that can be wrong; past ~10 paths, people stop testing them all.',
      ask: 'Is every branch tested? Could part of this be split out or turned into a lookup?',
    });
  }

  // Edges: new cycles and new cross-area dependencies.
  const fileEdges = head.edges.filter((e) => e.level === 'file');
  const adj = new Map<string, string[]>();
  for (const e of fileEdges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  for (const e of diff.edges.added) {
    if (e.level !== 'file') continue;
    if (closesCycle(adj, e.from, e.to)) {
      add(e.from, {
        kind: 'cycle',
        weight: 5,
        title: `New import of \`${e.to}\` creates an import cycle`,
        short: 'new import cycle',
        why: 'Cycles mean neither file can be understood, tested or moved without the other.',
        ask: 'Can the shared piece move to a third file both import?',
      });
    } else if (areaOf(e.from) !== areaOf(e.to) && !isTestPath(e.from)) {
      add(e.from, {
        kind: 'boundary',
        weight: 3,
        title: `New dependency: ${areaOf(e.from)} → ${areaOf(e.to)} (\`${e.to}\`)`,
        short: `imports ${areaOf(e.to)}`,
        why: 'Imports across areas are how layers erode; one is fine, the tenth is a tangle.',
        ask: `Should ${areaOf(e.from)} know about ${areaOf(e.to)}, or is something in the wrong place?`,
      });
    }
  }

  // Fan-in: how many files import each changed file.
  const importers = new Map<string, number>();
  for (const e of fileEdges) importers.set(e.to, (importers.get(e.to) ?? 0) + 1);
  for (const d of changed) {
    const n = importers.get(d.path) ?? 0;
    if (d.status === 'added' || d.status === 'removed' || n < o.fanInHigh) continue;
    add(d.path, {
      kind: 'fan-in',
      weight: 2 + Math.min(3, Math.floor(n / o.fanInHigh)),
      title: `${plural(n, 'file')} import this`,
      short: `${n} importers`,
      why: 'A change here reaches every importer; the diff only shows one side of it.',
      ask: 'Did any exported signature or behavior change? Are callers covered by tests?',
    });
  }

  // Hotspots: files in the top 10% by commits that several people touch. One person churning a
  // file is normal iteration, not a collision risk, so single-author files are not flagged.
  const hotLine = Math.max(5, quantile(head.files.map((f) => f.churn?.commits ?? 0), 0.9));
  for (const d of changed) {
    const c = d.head?.churn;
    if (!c || c.commits < hotLine || c.authors < 2 || isTestPath(d.path)) continue;
    add(d.path, {
      kind: 'hotspot',
      weight: c.authors >= 3 ? 3 : 2,
      short: 'hotspot',
      title: `Hotspot: ${plural(c.commits, 'commit')} by ${plural(c.authors, 'author')}${head.since ? ` in the last ${head.since}` : ''}`,
      why: 'Files that change constantly are where bugs cluster and where merges collide.',
      ask: 'Is this file doing too many jobs? Does this change make the next one easier or harder?',
    });
  }

  // Co-change: usual partners of a changed file that this change left alone.
  for (const c of head.coupling ?? []) {
    if (c.coChanges < o.coChangeMin) continue;
    for (const [mine, other] of [
      [c.a, c.b],
      [c.b, c.a],
    ] as const) {
      if (!changedSet.has(mine) || changedSet.has(other) || !headPaths.has(other)) continue;
      const commits = head.files.find((f) => f.path === mine)?.churn?.commits ?? 0;
      if (commits && c.coChanges / commits < o.coChangeShare) continue;
      add(mine, {
        kind: 'co-change',
        weight: isTestPath(other) ? 2 : 3,
        title: `\`${other}\` (in ${c.coChanges} of ${plural(commits || c.coChanges, 'commit')})`,
        short: `${basename(other)} not updated`,
        why: 'History says these move together; a missing half is a classic forgotten update.',
        ask: `Does \`${other}\` need a matching change?`,
      });
    }
  }

  // Tests: a file's tests are its sibling test file plus any test file that imports it. Flag logic
  // that grew while none of them changed, or logic no test reaches at all.
  const testers = new Map<string, Set<string>>();
  for (const e of fileEdges) {
    if (!isTestPath(e.from)) continue;
    const set = testers.get(e.to);
    if (set) set.add(e.from);
    else testers.set(e.to, new Set([e.from]));
  }
  for (const d of changed) {
    if (isTestPath(d.path) || d.status === 'removed' || d.status === 'renamed') continue;
    const grew = d.status === 'added' ? (d.head?.complexity?.sum ?? 0) >= o.complexityHigh : d.complexitySum >= o.complexityStep;
    if (!grew) continue;
    const tests = [...new Set([...testCandidates(d.path).filter((t) => headPaths.has(t)), ...(testers.get(d.path) ?? [])])];
    if (!tests.length) {
      add(d.path, {
        kind: 'tests',
        weight: 3,
        title: d.status === 'added' ? 'New file with real logic, and no test imports it' : 'Logic grew, and no test imports this file',
        short: 'no tests',
        why: 'Code no test touches is only checked by whoever runs it next, often in production.',
        ask: 'Where is this tested, or what would break if it were wrong?',
      });
    } else if (!tests.some((t) => changedSet.has(t))) {
      add(d.path, {
        kind: 'tests',
        weight: 2,
        title: `Logic grew but ${tests.length === 1 ? `\`${tests[0]}\` did` : `none of its ${tests.length} test files (\`${tests[0]}\`, …) did`} not change`,
        short: 'tests not updated',
        why: 'New branches without new test cases are untested by default.',
        ask: 'Which test covers the new behavior?',
      });
    }
  }

  const items: ReviewItem[] = changed.map((d) => {
    const s = mergeByKind(signals.get(d.path)!).sort((a, b) => b.weight - a.weight);
    const big = s.length && Math.abs(d.code) >= o.largeChange && !isTestPath(d.path) ? 1 : 0;
    const score = s.reduce((n, x) => n + x.weight, 0) + big;
    return { path: d.path, status: d.status, code: d.code, score, level: levelOf(score), signals: s };
  });
  return items.sort((a, b) => b.score - a.score || Math.abs(b.code) - Math.abs(a.code) || (a.path < b.path ? -1 : 1));
}
