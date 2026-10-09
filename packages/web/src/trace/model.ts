// Pure trace playback model (no DOM): per-file and per-edge "heat" that ticks add to and that decays
// exponentially with time, plus whole-trace totals for the summary mode.
import type { TraceTick } from '../data.ts';

/** Edge key, the same shape as graph/model.ts edgeKey. */
export const runtimeKey = (from: string, to: string): string => `${from}\n${to}`;

export interface Heat {
  files: Map<string, number>;
  /** runtimeKey(from, to) -> heat */
  edges: Map<string, number>;
}

export const emptyHeat = (): Heat => ({ files: new Map(), edges: new Map() });

/** Heat below this is dropped (a call decayed to nothing). */
const MIN_HEAT = 0.01;

/**
 * Share of heat left after `dtMs` when a node "stays lit" for `decayMs`: exp(-3 dt / decay), so about
 * 5% is left after `decayMs`.
 */
export function decayFactor(dtMs: number, decayMs: number): number {
  if (decayMs <= 0) return dtMs > 0 ? 0 : 1;
  return Math.exp((-3 * Math.max(0, dtMs)) / decayMs);
}

function scaleAll(m: Map<string, number>, f: number): void {
  for (const [k, v] of m) {
    const n = v * f;
    if (n < MIN_HEAT) m.delete(k);
    else m.set(k, n);
  }
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';
/** `[string, count]` file entries and `[string, string, count]` edge entries; anything else is skipped. */
const fileOk = (e: unknown): e is [string, number] => Array.isArray(e) && e.length === 2 && isStr(e[0]) && isCount(e[1]);
const edgeOk = (e: unknown): e is [string, string, number] =>
  Array.isArray(e) && e.length === 3 && isStr(e[0]) && isStr(e[1]) && isCount(e[2]);
const list = (a: unknown): unknown[] => (Array.isArray(a) ? a : []);

/**
 * A tick from the network (live stream, trace file) made safe for the reducer: null unless `t` is a
 * finite number >= 0; malformed file / edge entries are dropped. Same rules as the CLI's validateTick.
 */
export function cleanTick(v: unknown): TraceTick | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isCount(r.t) || !Array.isArray(r.files)) return null;
  return { t: r.t, files: r.files.filter(fileOk), edges: list(r.edges).filter(edgeOk) };
}

/** Add one tick's counts, each multiplied by `f` (its decay since the tick happened). Bad entries are skipped. */
export function addTick(heat: Heat, tick: TraceTick, f = 1): void {
  if (f <= 0) return;
  for (const e of list(tick.files)) if (fileOk(e)) heat.files.set(e[0], (heat.files.get(e[0]) ?? 0) + e[1] * f);
  for (const e of list(tick.edges)) {
    if (!edgeOk(e)) continue;
    const k = runtimeKey(e[0], e[1]);
    heat.edges.set(k, (heat.edges.get(k) ?? 0) + e[2] * f);
  }
}

/** Index of the first tick with t > `t` (ticks sorted by t). */
export function upperBound(ticks: TraceTick[], t: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The playback reducer: move `heat` from time t0 to t1 (t1 >= t0). Existing heat decays by t1 - t0,
 * then ticks from `cursor` with t <= t1 are added, each decayed by its age at t1. Returns the new
 * cursor (the first tick not yet applied). One call per animation frame batches every tick that
 * fell inside the frame.
 */
export function advance(heat: Heat, ticks: TraceTick[], cursor: number, t0: number, t1: number, decayMs: number): number {
  const f = decayFactor(t1 - t0, decayMs);
  if (f < 1) {
    scaleAll(heat.files, f);
    scaleAll(heat.edges, f);
  }
  let i = cursor;
  for (; i < ticks.length && ticks[i]!.t <= t1; i++) addTick(heat, ticks[i]!, decayFactor(t1 - ticks[i]!.t, decayMs));
  return i;
}

/**
 * Heat at time `t` from scratch (scrubbing, jumping, or catching up after a hidden tab). Same result
 * as advancing from 0, but only ticks within ~4 decay windows of `t` are read.
 */
export function heatAt(ticks: TraceTick[], t: number, decayMs: number): { heat: Heat; cursor: number } {
  const heat = emptyHeat();
  const cursor = upperBound(ticks, t);
  let start = cursor;
  while (start > 0 && t - ticks[start - 1]!.t <= decayMs * 4) start--;
  for (let i = start; i < cursor; i++) addTick(heat, ticks[i]!, decayFactor(t - ticks[i]!.t, decayMs));
  scaleAll(heat.files, 1);
  scaleAll(heat.edges, 1);
  return { heat, cursor };
}

export interface Totals {
  files: Map<string, number>;
  edges: Map<string, number>;
  /** Largest single-tick count of any file / edge (the playback color scale). */
  peakFile: number;
  peakEdge: number;
}

export function totals(ticks: TraceTick[]): Totals {
  const out: Totals = { files: new Map(), edges: new Map(), peakFile: 0, peakEdge: 0 };
  for (const tick of ticks) {
    for (const e of list(tick.files)) {
      if (!fileOk(e)) continue;
      const [p, n] = e;
      out.files.set(p, (out.files.get(p) ?? 0) + n);
      if (n > out.peakFile) out.peakFile = n;
    }
    for (const e of list(tick.edges)) {
      if (!edgeOk(e)) continue;
      const [from, to, n] = e;
      const k = runtimeKey(from, to);
      out.edges.set(k, (out.edges.get(k) ?? 0) + n);
      if (n > out.peakEdge) out.peakEdge = n;
    }
  }
  return out;
}

/**
 * Heat -> [0, 1] on a log scale, where `peak` is the largest per-tick count. Steady calls at the
 * peak rate pile up to peak / (1 - decayFactor(tickMs)), which maps to 1.
 */
export function intensity(heat: number, peak: number, tickMs: number, decayMs: number): number {
  if (heat <= 0 || peak <= 0) return 0;
  const ref = peak / Math.max(0.05, 1 - decayFactor(tickMs, decayMs));
  return Math.min(1, Math.log1p(heat) / Math.log1p(ref));
}

/** Insert `tick` keeping ticks sorted by t (live ticks can arrive out of order); returns its index. */
export function insertTick(ticks: TraceTick[], tick: TraceTick): number {
  let i = ticks.length;
  while (i > 0 && ticks[i - 1]!.t > tick.t) i--;
  ticks.splice(i, 0, tick);
  return i;
}

export interface EdgeClasses {
  /** Import edges that carried at least one call. */
  called: number;
  /** Import edges with no call in the trace. */
  uncalled: number;
  /** Distinct runtime caller -> callee pairs with no import edge in that direction. */
  runtimeOnly: number;
  calledKeys: Set<string>;
  runtimeOnlyKeys: Set<string>;
}

/** Classify the import graph's edges against a trace's runtime edges (both keyed by runtimeKey). */
export function classifyEdges(importKeys: Iterable<string>, runtime: Map<string, number>): EdgeClasses {
  const imports = new Set(importKeys);
  const out: EdgeClasses = { called: 0, uncalled: 0, runtimeOnly: 0, calledKeys: new Set(), runtimeOnlyKeys: new Set() };
  for (const k of imports) {
    if ((runtime.get(k) ?? 0) > 0) {
      out.called++;
      out.calledKeys.add(k);
    } else out.uncalled++;
  }
  for (const [k, n] of runtime) {
    if (n > 0 && !imports.has(k)) {
      out.runtimeOnly++;
      out.runtimeOnlyKeys.add(k);
    }
  }
  return out;
}
