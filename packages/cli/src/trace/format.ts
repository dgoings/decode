// Runtime trace file: JSON lines (gzip when the name ends in .gz). See docs/trace-format.md.
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import { createGzip, gunzipSync, type Gzip } from 'node:zlib';

export type TraceSource = 'browser' | 'server' | 'cpuprofile';

export interface TraceHeader {
  format: 'codeviz-trace';
  version: 1;
  repoId?: string;
  sha: string;
  /** ISO timestamp of t=0. */
  startedAt: string;
  tickMs: number;
  source: TraceSource;
}

/** [repo-relative path, calls] */
export type TraceFileCount = [string, number];
/** [from path, to path, calls] — `from` called into `to`. */
export type TraceEdge = [string, string, number];
/** [repo-relative path, function name, calls] */
export type TraceFunctionCount = [string, string, number];

export interface TraceTick {
  /** ms since header.startedAt */
  t: number;
  files: TraceFileCount[];
  edges: TraceEdge[];
  /** Optional per-function counts (browser coverage, server preload). */
  functions?: TraceFunctionCount[];
  /** Calls/samples attributed to paths outside the repo (node_modules, bundler runtime, data: URLs). */
  dropped?: number;
}

export interface Trace {
  header: TraceHeader;
  ticks: TraceTick[];
}

export function isTraceHeader(v: unknown): v is TraceHeader {
  return !!v && typeof v === 'object' && (v as TraceHeader).format === 'codeviz-trace';
}

const SOURCES = new Set(['browser', 'server', 'cpuprofile']);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Sanitized header, or null when a required field is missing or of the wrong type: `format`,
 * `version` 1, finite `tickMs`, string `startedAt` and string `sha` (may be empty: unknown sha).
 */
export function validateHeader(v: unknown): TraceHeader | null {
  if (!isTraceHeader(v)) return null;
  const h = v as unknown as Record<string, unknown>;
  if (h.version !== 1 || !isCount(h.tickMs) || !isStr(h.startedAt) || !isStr(h.sha)) return null;
  const out: TraceHeader = {
    format: 'codeviz-trace',
    version: 1,
    sha: h.sha,
    startedAt: h.startedAt,
    tickMs: h.tickMs,
    source: (SOURCES.has(h.source as string) ? h.source : 'server') as TraceSource,
  };
  if (isStr(h.repoId) && h.repoId) out.repoId = h.repoId;
  return out;
}

/**
 * Sanitized tick, or null when `t` is not a finite number >= 0 or `files` is not an array. Entries of
 * `files` / `edges` / `functions` that are not `[string, (string,) count]` with a finite count >= 0
 * are dropped; a missing `edges` becomes [].
 */
export function validateTick(v: unknown): TraceTick | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isCount(r.t) || !Array.isArray(r.files)) return null;
  const tuples = (a: unknown, strs: number) =>
    (Array.isArray(a) ? a : []).filter(
      (e: unknown) => Array.isArray(e) && e.length === strs + 1 && e.slice(0, strs).every(isStr) && isCount(e[strs]),
    );
  const out: TraceTick = {
    t: r.t,
    files: tuples(r.files, 1) as TraceFileCount[],
    edges: tuples(r.edges, 2) as TraceEdge[],
  };
  if (Array.isArray(r.functions)) out.functions = tuples(r.functions, 2) as TraceFunctionCount[];
  if (isCount(r.dropped)) out.dropped = r.dropped;
  return out;
}

/** Parse a trace file's text. Throws on a bad header or non-JSON lines; invalid ticks are dropped. */
export function parseTrace(text: string): Trace {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const parse = (l: string, i: number) => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
  };
  const first = lines.length ? parse(lines[0]!, 0) : undefined;
  if (!isTraceHeader(first)) throw new Error('not a codeviz trace (missing header line)');
  const header = validateHeader(first);
  if (!header) throw new Error('invalid trace header (needs version 1, tickMs, startedAt and sha)');
  const ticks: TraceTick[] = [];
  for (let i = 1; i < lines.length; i++) {
    const tick = validateTick(parse(lines[i]!, i));
    if (tick) ticks.push(tick);
  }
  return { header, ticks };
}

export function readTrace(path: string): Trace {
  const buf = readFileSync(path);
  const text = (path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
  return parseTrace(text);
}

export interface TraceWriter {
  write(record: TraceHeader | TraceTick): void;
  close(): Promise<void>;
}

/** Streaming writer; gzips when `path` ends in .gz. Call close() to flush. */
export function createTraceWriter(path: string): TraceWriter {
  const file: WriteStream = createWriteStream(path);
  const gz: Gzip | undefined = path.endsWith('.gz') ? createGzip() : undefined;
  if (gz) gz.pipe(file);
  const sink = gz ?? file;
  return {
    write(record) {
      sink.write(JSON.stringify(record) + '\n');
    },
    close() {
      return new Promise((resolve, reject) => {
        file.once('error', reject);
        file.once('close', () => resolve());
        sink.end();
      });
    },
  };
}

/** Sum a Map<key, n> into sorted [key, n] tuples (descending count). */
export function countsToTuples(m: Map<string, number>): TraceFileCount[] {
  return [...m].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function edgesToTuples(m: Map<string, number>): TraceEdge[] {
  return countsToTuples(m).map(([k, n]) => {
    const [from, to] = k.split('\0') as [string, string];
    return [from, to, n];
  });
}
