import type { LanguageTier, Snapshot, SnapshotDiff } from '@codeviz/core';

export type { LanguageTier, Snapshot, SnapshotDiff };

/** Sentinel "sha" for the uncommitted working tree. */
export const WORKTREE = 'WORKTREE';

export interface SnapshotSummary {
  sha: string;
  ref: string;
  analyzedAt: string;
  toolVersion: string;
  languages: Record<string, LanguageTier>;
}

export interface RefEntry {
  name: string;
  sha: string;
  kind: 'branch' | 'tag';
}

/** Mirrors GET /api/snapshots (and snapshots/index.json for static export). */
export interface SnapshotIndex {
  repo: string;
  repoId: string;
  head: string;
  snapshots: SnapshotSummary[];
  refs: RefEntry[];
  worktree: { analyzedAt: string } | null;
}

export interface DataSource {
  readonly kind: 'api' | 'static';
  index(): Promise<SnapshotIndex>;
  snapshot(sha: string): Promise<Snapshot>;
  analyze?(ref: string): Promise<{ sha: string }>;
  /** Diff two refs; blocks until both are analyzed. `head` may be WORKTREE. */
  compare?(base: string, head: string): Promise<SnapshotDiff>;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Request to ${url} failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep status text
    }
    throw new Error(message);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
}

export class ApiDataSource implements DataSource {
  readonly kind = 'api' as const;
  constructor(private readonly base = '/api') {}

  index(): Promise<SnapshotIndex> {
    return getJson(`${this.base}/snapshots`);
  }

  snapshot(sha: string): Promise<Snapshot> {
    return getJson(`${this.base}/snapshots/${encodeURIComponent(sha)}`);
  }

  analyze(ref: string): Promise<{ sha: string }> {
    return getJson(`${this.base}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
  }

  compare(base: string, head: string): Promise<SnapshotDiff> {
    const q = new URLSearchParams({ base, head });
    return getJson(`${this.base}/compare?${q}`);
  }
}

export class StaticDataSource implements DataSource {
  readonly kind = 'static' as const;
  constructor(private readonly base = 'snapshots') {}

  index(): Promise<SnapshotIndex> {
    return getJson(`${this.base}/index.json`);
  }

  snapshot(sha: string): Promise<Snapshot> {
    return getJson(`${this.base}/${encodeURIComponent(sha)}.json`);
  }

  compare(_base: string, _head: string): Promise<SnapshotDiff> {
    return Promise.reject(new Error('compare is not available in static exports'));
  }
}

/** ApiDataSource when served over http(s) and /api/snapshots answers; otherwise static. */
export async function pickDataSource(): Promise<DataSource> {
  if (window.location.protocol !== 'file:') {
    try {
      const res = await fetch('/api/snapshots', { method: 'GET' });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.includes('json')) return new ApiDataSource();
    } catch {
      // fall through to static
    }
  }
  return new StaticDataSource();
}

/** True when `sha` has a snapshot available in the index. */
export function isAnalyzed(index: SnapshotIndex, sha: string): boolean {
  if (sha === WORKTREE) return index.worktree !== null;
  return index.snapshots.some((s) => s.sha === sha);
}
