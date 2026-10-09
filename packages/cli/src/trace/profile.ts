// Script-to-source mapping and CPU profile (.cpuprofile / CDP Profiler.stop) bucketing.
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchPolicy, fetchText, LineIndex, loadSourceMap, RepoPaths, sourceMappingUrl, type SourceMapIndex } from './sourcemap.ts';

export interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string;
}

export interface CpuProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
  hitCount?: number;
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

interface ScriptInfo {
  map?: SourceMapIndex;
  lines?: LineIndex;
  /** http(s) script on an origin the fetch policy does not allow: never fetched, always dropped. */
  blocked?: boolean;
}

/** Maps (script, line, column) locations to repo paths, through source maps when the script has one. */
export class ScriptMapper {
  private scripts = new Map<string, Promise<ScriptInfo>>();
  private ready = new Map<string, ScriptInfo>();
  readonly warnings: string[] = [];

  /** `canFetch` gates every network request (scripts, SourceMap headers, maps); default loopback only. */
  constructor(
    readonly paths: RepoPaths,
    readonly canFetch: (url: string) => boolean = fetchPolicy(),
  ) {}

  /**
   * Load a script's source map once. `key` is a CDP scriptId or the URL. `getSource` supplies the
   * generated source (for the sourceMappingURL comment and offset→line conversion).
   */
  prepare(key: string, url: string, getSource: () => Promise<string | undefined>, mapRef?: string): Promise<void> {
    let p = this.scripts.get(key);
    if (!p) {
      p = this.load(url, getSource, mapRef).then((info) => {
        this.ready.set(key, info);
        return info;
      });
      this.scripts.set(key, p);
    }
    return p.then(() => undefined);
  }

  private async load(url: string, getSource: () => Promise<string | undefined>, mapRef?: string): Promise<ScriptInfo> {
    // Scripts without a sourceMappingURL (Bun cpuprofile .ts paths, unbundled dev servers) map to their own URL.
    // node_modules scripts are dropped anyway; don't fetch their maps.
    if (!url || url.startsWith('data:') || /[\\/]node_modules[\\/]/.test(url)) return {};
    if (/^https?:/i.test(url) && !this.canFetch(url)) return { blocked: true };
    let source: string | undefined;
    try {
      source = await getSource();
    } catch {
      source = undefined;
    }
    const info: ScriptInfo = { lines: source !== undefined ? new LineIndex(source) : undefined };
    let ref = mapRef || (source !== undefined ? sourceMappingUrl(source) : undefined);
    if (!ref && /^https?:/.test(url)) ref = await headerSourceMap(url);
    if (!ref) return info;
    const base = isAbsolute(url) ? pathToFileURL(url).href : url;
    try {
      if (!ref.startsWith('data:') && !this.canFetch(new URL(ref, base).href)) return info;
      info.map = await loadSourceMap(base, ref);
    } catch (err) {
      this.warnings.push(`source map for ${url}: ${(err as Error).message}`);
    }
    return info;
  }

  /** Repo path for a 0-based line/column in a prepared script (falls back to the URL itself). */
  locate(key: string, url: string, line: number, col: number): string | undefined {
    const info = this.ready.get(key);
    if (info?.blocked) return undefined;
    if (info?.map) {
      const src = info.map.sourceAt(line, col);
      return src === undefined ? undefined : this.paths.resolve(src);
    }
    return this.paths.resolve(url);
  }

  locateOffset(key: string, url: string, offset: number): string | undefined {
    const info = this.ready.get(key);
    if (info?.blocked) return undefined;
    if (info?.map && info.lines) {
      const { line, col } = info.lines.position(offset);
      return this.locate(key, url, line, col);
    }
    return this.paths.resolve(url);
  }
}

async function headerSourceMap(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.headers.get('sourcemap') ?? res.headers.get('x-sourcemap') ?? undefined;
  } catch {
    return undefined;
  }
}

const META = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

export interface Bucket {
  files: Map<string, number>;
  edges: Map<string, number>;
  dropped: number;
}

/** Resolve every frame of a profile (loading source maps for http scripts) to a repo path or undefined. */
export async function resolveProfileFrames(
  profile: CpuProfile,
  mapper: ScriptMapper,
  getSource: (key: string, url: string) => Promise<string | undefined> = (_k, url) => fetchText(url),
): Promise<Map<number, string | undefined>> {
  await Promise.all(
    profile.nodes.map((n) => {
      const { url, scriptId } = n.callFrame;
      const key = scriptId && scriptId !== '0' ? scriptId : url;
      return url ? mapper.prepare(key, url, () => getSource(key, url)) : undefined;
    }),
  );
  const out = new Map<number, string | undefined>();
  for (const n of profile.nodes) {
    const { url, scriptId, lineNumber, columnNumber } = n.callFrame;
    out.set(n.id, url ? mapper.locate(scriptId && scriptId !== '0' ? scriptId : url, url, lineNumber, columnNumber) : undefined);
  }
  return out;
}

/**
 * Bucket a sampled profile into ticks. Per sample, every distinct repo file on the stack gets +1
 * and every adjacent caller→callee frame pair in different repo files gets +1 (sample counts, not calls).
 * Samples whose leaf frame is outside the repo count as dropped.
 */
export function bucketProfile(profile: CpuProfile, fileOf: Map<number, string | undefined>, tickMs: number): Bucket[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

  const memo = new Map<number, { files: string[]; edges: string[] }>();
  const stackOf = (id: number): { files: string[]; edges: string[] } => {
    const hit = memo.get(id);
    if (hit) return hit;
    // Iterative climb to the nearest memoized ancestor, then fill downward.
    const chain: number[] = [];
    let cur: number | undefined = id;
    while (cur !== undefined && !memo.has(cur)) {
      chain.push(cur);
      cur = parent.get(cur);
    }
    let acc = cur !== undefined ? memo.get(cur)! : { files: [], edges: [] };
    for (let i = chain.length - 1; i >= 0; i--) {
      const nid = chain[i]!;
      const f = fileOf.get(nid);
      const p = parent.get(nid);
      const pf = p !== undefined ? fileOf.get(p) : undefined;
      const files = f && !acc.files.includes(f) ? [...acc.files, f] : acc.files;
      const key = f && pf && f !== pf ? `${pf}\0${f}` : undefined;
      const edges = key && !acc.edges.includes(key) ? [...acc.edges, key] : acc.edges;
      acc = { files, edges };
      memo.set(nid, acc);
    }
    return acc;
  };

  const buckets: Bucket[] = [];
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let time = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    time += deltas[i] ?? 0;
    const id = samples[i]!;
    const node = byId.get(id);
    if (!node || META.has(node.callFrame.functionName)) continue;
    const idx = Math.max(0, Math.floor((time - profile.startTime) / 1000 / tickMs));
    while (buckets.length <= idx) buckets.push({ files: new Map(), edges: new Map(), dropped: 0 });
    const b = buckets[idx]!;
    if (!fileOf.get(id)) b.dropped++;
    const s = stackOf(id);
    for (const f of s.files) b.files.set(f, (b.files.get(f) ?? 0) + 1);
    for (const e of s.edges) b.edges.set(e, (b.edges.get(e) ?? 0) + 1);
  }
  return buckets;
}
