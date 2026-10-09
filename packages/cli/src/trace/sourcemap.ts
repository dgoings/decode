// Minimal source-map v3 reader (no dependency) + mapping of script/source URLs to repo paths.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

/** Per generated line: flat [genCol, sourceIndex, genCol, sourceIndex, ...] sorted by genCol (-1 = unmapped). */
type Lines = number[][];

function decodeMappings(mappings: string): Lines {
  const lines: Lines = [];
  let src = 0;
  for (const line of mappings.split(';')) {
    const segs: number[] = [];
    let col = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const vals: number[] = [];
      let shift = 0;
      let value = 0;
      for (const ch of seg) {
        const d = B64.get(ch);
        if (d === undefined) break;
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      col += vals[0] ?? 0;
      if (vals.length >= 4) {
        src += vals[1]!;
        segs.push(col, src);
      } else segs.push(col, -1);
    }
    lines.push(segs);
  }
  return lines;
}

export interface RawSourceMap {
  version?: number;
  sources: (string | null)[];
  sourceRoot?: string;
  mappings: string;
  sections?: unknown;
}

export class SourceMapIndex {
  private lines: Lines;
  /** Sources resolved to absolute URLs (relative to the map's URL and sourceRoot). */
  readonly sources: string[];

  constructor(map: RawSourceMap, mapUrl?: string) {
    if (map.sections) throw new Error('indexed source maps (sections) are not supported');
    this.lines = decodeMappings(map.mappings);
    const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
    this.sources = map.sources.map((s) => {
      const raw = root + (s ?? '');
      if (!mapUrl) return raw;
      try {
        return new URL(raw, mapUrl).href;
      } catch {
        return raw;
      }
    });
  }

  /** Original source URL for a 0-based generated line/column, or undefined when unmapped. */
  sourceAt(line: number, col: number): string | undefined {
    const segs = this.lines[line];
    if (!segs || !segs.length) return undefined;
    let lo = 0;
    let hi = segs.length / 2 - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid * 2]! <= col) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // A function's start column may precede the first mapped segment on its line; fall back to the first.
    const idx = segs[(best < 0 ? 0 : best) * 2 + 1]!;
    return idx < 0 ? undefined : this.sources[idx];
  }
}

/** 0-based line/column for a character offset in `text`. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  position(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - this.starts[lo]! };
  }
}

/** Last `//# sourceMappingURL=` in a script. */
export function sourceMappingUrl(source: string): string | undefined {
  const m = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(source.slice(-4096)) ?? /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(source);
  return m?.[1];
}

export async function fetchText(url: string): Promise<string> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    return meta.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
  }
  if (url.startsWith('file:')) return readFileSync(fileURLToPath(url), 'utf8');
  if (isAbsolute(url)) return readFileSync(url, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Which URLs the CLI may request itself (scripts, SourceMap headers, .map files): the given origins,
 * plus any loopback host when `loopback` is set. Non-http(s) locations (data:, file:, plain paths)
 * need no network and pass; anything else (other hosts, ws:, chrome-extension:) is refused.
 */
export function fetchPolicy(origins: string[] = [], loopback = true): (url: string) => boolean {
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  return (url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return isAbsolute(url); // plain local path
    }
    if (u.protocol === 'data:' || u.protocol === 'file:') return true;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return allowed.has(u.origin) || (loopback && LOOPBACK.has(u.hostname));
  };
}

/** Load the source map for a script. `mapRef` comes from the script comment, CDP, or a SourceMap header. */
export async function loadSourceMap(scriptUrl: string, mapRef: string): Promise<SourceMapIndex> {
  const mapUrl = mapRef.startsWith('data:') ? mapRef : new URL(mapRef, scriptUrl).href;
  const raw = JSON.parse(await fetchText(mapUrl)) as RawSourceMap;
  return new SourceMapIndex(raw, mapUrl.startsWith('data:') ? scriptUrl : mapUrl);
}

/** Classifies source locations as repo-relative paths (forward slashes) or outside the repo. */
export class RepoPaths {
  readonly root: string;
  private known: (rel: string) => boolean;
  private cache = new Map<string, string | undefined>();

  /** `known` defaults to `git ls-files` in root (what the snapshot walks), else existsSync. */
  constructor(root: string, known?: Iterable<string> | ((rel: string) => boolean)) {
    this.root = root;
    if (typeof known === 'function') this.known = known;
    else if (known) {
      const set = new Set(known);
      this.known = (r) => set.has(r);
    } else {
      const set = gitFiles(root);
      this.known = set ? (r) => set.has(r) : (r) => existsSync(join(root, r));
    }
  }

  /** Repo-relative path for a file path / file: / http(s): / bundler-scheme URL, or undefined if outside the repo. */
  resolve(location: string): string | undefined {
    if (this.cache.has(location)) return this.cache.get(location);
    const out = this.compute(location);
    this.cache.set(location, out);
    return out;
  }

  private compute(location: string): string | undefined {
    if (!location || /^(?:data|node|bun):/.test(location)) return undefined;
    let p = location.split(/[?#]/)[0]!;
    try {
      if (p.startsWith('file:')) p = fileURLToPath(p);
      else if (/^[a-z][\w+.-]*:\/\//i.test(p)) p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return undefined;
    }
    if (p.includes('node_modules/') || p.includes('node_modules\\')) return undefined;
    const candidates: string[] = [];
    if (isAbsolute(p)) {
      const rel = relative(this.root, p);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) candidates.push(rel.split(sep).join('/'));
    }
    candidates.push(posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\.?\/)+/, '').replace(/^\/+/, ''));
    for (const c of candidates) if (c && !c.startsWith('..') && this.known(c)) return c;
    return undefined;
  }
}

function gitFiles(root: string): Set<string> | undefined {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.toString('utf8').split('\0').filter(Boolean));
  } catch {
    return undefined;
  }
}
