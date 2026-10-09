// In-memory traces for `codeviz serve --trace <file>` / `--trace-listen`: recorded files plus live
// streams posted by harness/bun-trace.ts (same NDJSON bodies `codeviz trace collect` accepts).
// Never written to disk.
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { isTraceHeader, type Trace, type TraceHeader, type TraceSource, type TraceTick } from './format.ts';

/** One entry of GET /api/traces and snapshots/traces/index.json. */
export interface TraceInfo {
  id: string;
  source: TraceSource;
  sha: string;
  repoId?: string;
  startedAt: string;
  tickMs: number;
  /** Number of ticks so far. */
  ticks: number;
  /** `t` of the last tick (0 when there are none). */
  durationMs: number;
  /** Received over HTTP while serving (may still grow); false for files. */
  live: boolean;
}

interface Entry {
  id: string;
  trace: Trace;
  live: boolean;
  /** Cached gzipped JSON of the whole trace; dropped whenever a tick arrives. */
  gz?: Buffer;
  listeners: Set<(tick: TraceTick, index: number) => void>;
}

const ID_CHARS = /[^A-Za-z0-9._-]+/g;

/** File name without .jsonl(.gz)/.json(.gz), safe for URLs and file names. */
export function traceIdFromFile(file: string): string {
  const base = path.basename(file).replace(/\.gz$/i, '').replace(/\.(jsonl|json|ndjson)$/i, '');
  return base.replace(ID_CHARS, '-').replace(/^-+|-+$/g, '') || 'trace';
}

export function traceInfo(id: string, trace: Trace, live: boolean): TraceInfo {
  const { header: h, ticks } = trace;
  const info: TraceInfo = {
    id,
    source: h.source,
    sha: h.sha,
    startedAt: h.startedAt,
    tickMs: h.tickMs,
    ticks: ticks.length,
    durationMs: ticks.length ? ticks[ticks.length - 1]!.t : 0,
    live,
  };
  if (h.repoId) info.repoId = h.repoId;
  return info;
}

/** Ticks sorted by `t` (stable), so playback can walk them in order. */
export function sortTicks(ticks: TraceTick[]): TraceTick[] {
  return ticks.every((tk, i) => i === 0 || ticks[i - 1]!.t <= tk.t) ? ticks : [...ticks].sort((a, b) => a.t - b.t);
}

export class TraceStore {
  private readonly entries = new Map<string, Entry>();
  /** Live traces by `${source} ${startedAt} ${sha}` (one per traced process). */
  private readonly liveByKey = new Map<string, Entry>();

  private uniqueId(want: string): string {
    let id = want;
    for (let i = 2; this.entries.has(id); i++) id = `${want}-${i}`;
    return id;
  }

  /** Add a recorded trace; returns its id (derived from `name`, made unique). */
  add(trace: Trace, name: string): string {
    const id = this.uniqueId(traceIdFromFile(name));
    this.entries.set(id, { id, trace: { header: trace.header, ticks: sortTicks(trace.ticks) }, live: false, listeners: new Set() });
    return id;
  }

  list(): TraceInfo[] {
    return [...this.entries.values()].map((e) => traceInfo(e.id, e.trace, e.live));
  }

  get(id: string): Trace | undefined {
    return this.entries.get(id)?.trace;
  }

  isLive(id: string): boolean {
    return this.entries.get(id)?.live ?? false;
  }

  /** Gzipped `{header, ticks}` JSON, cached until the trace changes. */
  gz(id: string): Buffer | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.gz ??= gzipSync(JSON.stringify(e.trace));
    return e.gz;
  }

  /** Call `fn` for each tick added to live trace `id` from now on; returns an unsubscribe function. */
  subscribe(id: string, fn: (tick: TraceTick, index: number) => void): () => void {
    const e = this.entries.get(id);
    if (!e) return () => {};
    e.listeners.add(fn);
    return () => e.listeners.delete(fn);
  }

  /**
   * One POST body from the Bun preload (or any live capture): NDJSON with a header line followed by
   * ticks. Ticks before any header in the body are ignored. Returns the number of ticks accepted;
   * throws on invalid JSON.
   */
  accept(body: string): number {
    let cur: Entry | undefined;
    let n = 0;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as unknown;
      if (isTraceHeader(rec)) {
        cur = this.liveEntry(rec);
        continue;
      }
      const tick = rec as TraceTick;
      if (!cur || typeof tick?.t !== 'number' || !Array.isArray(tick.files)) continue;
      const clean: TraceTick = { ...tick, edges: Array.isArray(tick.edges) ? tick.edges : [] };
      const ticks = cur.trace.ticks;
      // Posts can land out of order; keep ticks sorted by t.
      let i = ticks.length;
      while (i > 0 && ticks[i - 1]!.t > clean.t) i--;
      ticks.splice(i, 0, clean);
      cur.gz = undefined;
      for (const fn of cur.listeners) fn(clean, i);
      n++;
    }
    return n;
  }

  private liveEntry(h: TraceHeader): Entry {
    const key = `${h.source} ${h.startedAt} ${h.sha}`;
    let e = this.liveByKey.get(key);
    if (!e) {
      const id = this.uniqueId(`live-${h.source}-${h.startedAt.replace(/[^0-9]/g, '').slice(8, 14)}`);
      const header: TraceHeader = {
        format: 'codeviz-trace',
        version: 1,
        sha: String(h.sha),
        startedAt: String(h.startedAt),
        tickMs: Number(h.tickMs) || 1000,
        source: h.source,
        ...(h.repoId ? { repoId: String(h.repoId) } : {}),
      };
      e = { id, trace: { header, ticks: [] }, live: true, listeners: new Set() };
      this.entries.set(id, e);
      this.liveByKey.set(key, e);
    }
    return e;
  }
}
