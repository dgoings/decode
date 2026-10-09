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

export function parseTrace(text: string): Trace {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const first = lines.length ? JSON.parse(lines[0]!) : undefined;
  if (!isTraceHeader(first)) throw new Error('not a codeviz trace (missing header line)');
  return { header: first, ticks: lines.slice(1).map((l) => JSON.parse(l) as TraceTick) };
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
