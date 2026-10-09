import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * An overlay: external per-file numbers (coverage, bundle bytes, error counts...) attached at
 * serve/export time. Never cached: it is an input, not an analysis result.
 */
export interface Overlay {
  name: string;
  unit: string;
  /** True when a high value is good (coverage): the UI then draws low values in the hot color. */
  higherIsBetter: boolean;
  min?: number;
  max?: number;
  /** [path relative to the repo root, value]. */
  rows: [string, number][];
}

/** What GET /api/overlays and snapshots/overlays/index.json list per overlay. */
export interface OverlaySummary {
  name: string;
  unit: string;
  higherIsBetter: boolean;
  min?: number;
  max?: number;
  rows: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Same shape as walker paths: forward slashes, no leading ./, relative to `root` when absolute under it. */
export function normalizePath(p: string, root?: string): string {
  let s = p.trim().replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.startsWith(r + '/')) s = s.slice(r.length + 1);
  }
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/\/{2,}/g, '/');
}

/** Parse overlay JSON, or CSV (`path,value` header) named after the file's basename. Throws on bad input. */
export function parseOverlay(text: string, file: string, root?: string): Overlay {
  let o: Overlay;
  if (/\.csv$/i.test(file)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!/^\s*path\s*,\s*value\s*$/i.test(lines[0] ?? '')) throw new Error(`${file}: CSV must start with a "path,value" header`);
    const rows = lines.slice(1).map((line, i): [string, number] => {
      const at = line.lastIndexOf(',');
      const v = Number(line.slice(at + 1));
      if (at < 0 || line.slice(at + 1).trim() === '' || !Number.isFinite(v)) throw new Error(`${file}:${i + 2}: expected path,number`);
      return [line.slice(0, at).replace(/^"(.*)"$/, '$1'), v];
    });
    o = { name: path.basename(file).replace(/\.csv$/i, ''), unit: '', higherIsBetter: false, rows };
  } else {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) throw new Error(`${file}: expected { name, rows: [[path, value], ...] }`);
    const num = (k: string) => {
      const v = raw[k];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${file}: "${k}" must be a number`);
      return v;
    };
    const rows = (raw.rows as unknown[]).map((r, i): [string, number] => {
      if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'number' || !Number.isFinite(r[1])) {
        throw new Error(`${file}: rows[${i}] must be [path, number]`);
      }
      return [r[0], r[1]];
    });
    o = {
      name: typeof raw.name === 'string' ? raw.name : path.basename(file).replace(/\.json$/i, ''),
      unit: typeof raw.unit === 'string' ? raw.unit : '',
      higherIsBetter: raw.higherIsBetter === true,
      min: num('min'),
      max: num('max'),
      rows,
    };
    if (o.min === undefined) delete o.min;
    if (o.max === undefined) delete o.max;
  }
  if (!NAME.test(o.name)) throw new Error(`${file}: overlay name "${o.name}" must be letters, digits, ".", "_" or "-"`);
  // Normalize, and keep the last value when a path repeats.
  const byPath = new Map<string, number>();
  for (const [p, v] of o.rows) {
    const n = normalizePath(p, root);
    if (n) byPath.set(n, v);
  }
  o.rows = [...byPath];
  return o;
}

/** Read and parse each overlay file; throws on unreadable files, bad input or duplicate names. */
export function loadOverlays(files: string[], root?: string): Overlay[] {
  const out: Overlay[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (err) {
      throw new Error(`cannot read overlay ${f}: ${(err as Error).message}`);
    }
    const o = parseOverlay(text, f, root);
    if (out.some((x) => x.name === o.name)) throw new Error(`duplicate overlay name "${o.name}" (${f})`);
    out.push(o);
  }
  return out;
}

/** Rows whose path is not one of `files`. */
export function unmatchedRows(o: Overlay, files: Iterable<string>): number {
  const known = new Set(files);
  return o.rows.filter(([p]) => !known.has(p)).length;
}

/** Log `overlay <name>: n of m rows did not match a file` once per overlay that has misses. */
export function reportUnmatched(overlays: Overlay[], files: string[], log: (s: string) => void): void {
  for (const o of overlays) {
    const n = unmatchedRows(o, files);
    if (n > 0) log(`overlay ${o.name}: ${n} of ${o.rows.length} rows did not match a file`);
  }
}

export function summarize(o: Overlay): OverlaySummary {
  const { rows, ...rest } = o;
  return { ...rest, rows: rows.length };
}

/**
 * lcov tracefile -> line-coverage overlay (lines hit / lines found, percent, one decimal).
 * Files with no instrumented lines are skipped. Relative SF: paths are resolved against `cwd` when given
 * (lcov writers record them relative to where the tests ran), then made relative to `root`.
 */
export function lcovToOverlay(text: string, root?: string, cwd?: string): Overlay {
  const rows: [string, number][] = [];
  let file: string | null = null;
  let lf = 0;
  let lh = 0;
  let daFound = 0;
  let daHit = 0;
  let hasLF = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      file = line.slice(3);
      lf = lh = daFound = daHit = 0;
      hasLF = false;
    } else if (line.startsWith('DA:')) {
      daFound++;
      if (Number(line.slice(3).split(',')[1]) > 0) daHit++;
    } else if (line.startsWith('LF:')) {
      lf = Number(line.slice(3));
      hasLF = true;
    } else if (line.startsWith('LH:')) {
      lh = Number(line.slice(3));
    } else if (line === 'end_of_record' && file !== null) {
      const found = hasLF ? lf : daFound;
      const hit = hasLF ? lh : daHit;
      if (found > 0) {
        const abs = cwd && !path.isAbsolute(file) ? path.resolve(cwd, file) : file;
        const p = normalizePath(abs, root);
        if (p) rows.push([p, Math.round((1000 * hit) / found) / 10]);
      }
      file = null;
    }
  }
  return { name: 'coverage', unit: '%', higherIsBetter: true, min: 0, max: 100, rows };
}
