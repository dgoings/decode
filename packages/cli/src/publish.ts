import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Names `particles deploy` skips at any depth (mirrors SKIP in the Particles CLI). */
export const PARTICLES_SKIP = new Set(['node_modules', '.git', '.DS_Store', 'data']);
/** The shim on this machine pins this host; used when no shim or env says otherwise. */
export const DEFAULT_PARTICLES_HOST = 'https://particles.atomicobject.com';
/** The Particles CLI documents no byte limit for its single deploy POST; stay conservative. */
export const DEFAULT_MAX_PAYLOAD_MB = 20;

export interface DeployPayload {
  files: number;
  /** Raw bytes on disk. */
  bytes: number;
  /** Sum of base64-encoded sizes: what the deploy POST carries. */
  base64Bytes: number;
  perFile: Array<{ path: string; base64Bytes: number }>;
}

export const base64Size = (n: number): number => Math.ceil(n / 3) * 4;

/** What `particles deploy <dir>` would upload, sized as base64. */
export function estimateDeployPayload(dir: string): DeployPayload {
  const out: DeployPayload = { files: 0, bytes: 0, base64Bytes: 0, perFile: [] };
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (PARTICLES_SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else {
        const size = statSync(path.join(dir, r)).size;
        out.files++;
        out.bytes += size;
        out.base64Bytes += base64Size(size);
        out.perFile.push({ path: r, base64Bytes: base64Size(size) });
      }
    }
  };
  walk('');
  return out;
}

export interface RefCost {
  sha: string;
  ref: string;
  snapshot: number;
  /** Compare files with this ref on either side. */
  compare: number;
}

/** Split a payload into the shared part (web UI, index) and per-ref snapshot + compare costs (base64 bytes). */
export function refBreakdown(
  payload: DeployPayload,
  refs: Array<{ sha: string; ref: string }>,
): { shared: number; perRef: RefCost[]; pairs: Map<string, number> } {
  const perRef = refs.map((r) => ({ sha: r.sha, ref: r.ref, snapshot: 0, compare: 0 }));
  const bySha = new Map(perRef.map((r) => [r.sha, r]));
  const pairs = new Map<string, number>(); // "<a>-<b>" -> bytes
  let shared = 0;
  for (const f of payload.perFile) {
    const snap = /^snapshots\/([0-9a-f]+)\.json\.gz$/.exec(f.path);
    const cmp = /^snapshots\/compare\/([0-9a-f]+)-([0-9a-f]+)\.json\.gz$/.exec(f.path);
    if (snap && bySha.has(snap[1]!)) bySha.get(snap[1]!)!.snapshot += f.base64Bytes;
    else if (cmp && bySha.has(cmp[1]!) && bySha.has(cmp[2]!)) {
      bySha.get(cmp[1]!)!.compare += f.base64Bytes;
      bySha.get(cmp[2]!)!.compare += f.base64Bytes;
      pairs.set(`${cmp[1]}-${cmp[2]}`, f.base64Bytes);
    } else shared += f.base64Bytes;
  }
  return { shared, perRef, pairs };
}

/**
 * Greedily pick refs to drop (largest saving first) until the payload fits `limit`.
 * Returns null when even a single ref does not fit.
 */
export function suggestDrops(payload: DeployPayload, refs: Array<{ sha: string; ref: string }>, limit: number): string[] | null {
  const { shared, perRef, pairs } = refBreakdown(payload, refs);
  const kept = new Set(perRef.map((r) => r.sha));
  const total = (): number => {
    let n = shared;
    for (const r of perRef) if (kept.has(r.sha)) n += r.snapshot;
    for (const [k, v] of pairs) {
      const [a, b] = k.split('-');
      if (kept.has(a!) && kept.has(b!)) n += v;
    }
    return n;
  };
  const dropped: string[] = [];
  while (total() > limit) {
    if (kept.size <= 1) return null;
    let best: RefCost | undefined;
    let bestSave = -1;
    const before = total();
    for (const r of perRef) {
      if (!kept.has(r.sha)) continue;
      kept.delete(r.sha);
      const save = before - total();
      kept.add(r.sha);
      if (save > bestSave) {
        bestSave = save;
        best = r;
      }
    }
    kept.delete(best!.sha);
    dropped.push(best!.ref);
  }
  return dropped;
}

export function readParticlesToken(): string | null {
  try {
    return readFileSync(path.join(process.env.HOME || homedir(), '.particles', 'token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Absolute path of an executable named `name` on PATH, or null. */
export function findOnPath(name: string): string | null {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * The Particles API host: CODEVIZ_PARTICLES_HOST (tests), then PARTICLES_HOST (honored by the shim),
 * then the default the `particles` shim on PATH pins, then DEFAULT_PARTICLES_HOST.
 */
export function particlesHost(): string {
  const env = process.env.CODEVIZ_PARTICLES_HOST || process.env.PARTICLES_HOST;
  if (env) return env.replace(/\/+$/, '');
  const shim = findOnPath('particles');
  if (shim) {
    try {
      const m = /PARTICLES_HOST:-([^}"'\s]+)\}/.exec(readFileSync(shim, 'utf8').slice(0, 4096));
      if (m) return m[1]!.replace(/\/+$/, '');
    } catch {
      // unreadable shim
    }
  }
  return DEFAULT_PARTICLES_HOST;
}

/** `https://<site>.<particles-host>` */
export function siteUrl(host: string, name: string): string {
  const u = new URL(host);
  return `${u.protocol}//${name}.${u.host}`;
}

export interface ParticlesSite {
  name: string;
  deployer: string | null;
  size_bytes: number;
  last_deployed_at: string;
}

/** GET /api/sites (read-only). Returns null and warns on any failure. */
export async function listParticlesSites(
  host: string,
  token: string,
  warn: (s: string) => void = (s) => console.error(s),
  timeoutMs = 5000,
): Promise<ParticlesSite[] | null> {
  try {
    const r = await fetch(`${host}/api/sites`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { sites?: ParticlesSite[] };
    if (!Array.isArray(body.sites)) throw new Error('unexpected response');
    return body.sites;
  } catch (err) {
    warn(`warning: could not list Particles sites at ${host} (${(err as Error).message})`);
    return null;
  }
}

/** Quote for a POSIX shell when needed. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
