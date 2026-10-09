import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { diffSnapshots, encodeSnapshot, type Snapshot } from '@codeviz/core';
import { analyzeRef } from './analyze.ts';
import { listSnapshots, readSnapshot, type SnapshotSummary } from './cache.ts';
import { compareRenames } from './compare.ts';
import { resolveRef } from './refs.ts';
import { repoId, repoName } from './repo.ts';
import { findWebDir } from './server.ts';
import { version } from './version.ts';

/** Above this many refs, pairwise compare files are not precomputed (n*(n-1) diffs). */
export const MAX_COMPARE_REFS = 8;

export interface ExportOptions {
  /** Any directory inside the repo. */
  root: string;
  /** Output directory. Must not exist or be empty unless `overwrite`. */
  dir: string;
  /** Refs to export; empty means every cached snapshot of this repo (current tool version). */
  refs: string[];
  since: string;
  /** Re-analyze given refs even when cached. */
  force?: boolean;
  /** Allow a non-empty `dir`: replaces index.html, the web build's files and snapshots/ in it. */
  overwrite?: boolean;
  /** Built web UI to copy (default: the same lookup `codeviz serve` uses). */
  webDir?: string;
  log?: (s: string) => void;
}

export interface ExportResult {
  dir: string;
  snapshots: SnapshotSummary[];
  /** Number of precomputed compare files (0 when skipped). */
  pairs: number;
  pairsSkipped: boolean;
  bytes: number;
}

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

/**
 * Write a static codeviz site to `opts.dir`: the built web UI, snapshots/index.json,
 * snapshots/<sha>.json.gz per ref and snapshots/compare/<base>-<head>.json.gz per ordered pair.
 * Throws (before writing anything) on WORKTREE, unknown refs, a non-empty dir or a missing web build.
 */
export async function exportSite(opts: ExportOptions): Promise<ExportResult> {
  const log = opts.log ?? (() => {});
  if (opts.refs.includes('WORKTREE')) throw new Error('WORKTREE cannot be exported (it is never cached)');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: opts.root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const id = repoId(root);

  // Validate everything before writing or analyzing.
  const unknown: string[] = [];
  for (const r of opts.refs) {
    try {
      resolveRef(root, r);
    } catch {
      unknown.push(r);
    }
  }
  if (unknown.length) throw new Error(`unknown git ref${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);

  const dir = path.resolve(opts.dir);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    if (readdirSync(dir).length > 0 && !opts.overwrite) throw new Error(`${dir} is not empty (use --overwrite)`);
  }
  const webDir = opts.webDir ?? findWebDir();
  if (!webDir || !existsSync(path.join(webDir, 'index.html'))) {
    throw new Error('the web UI is not built (no index.html found); run `bun run build` in the codeviz checkout');
  }

  // Collect snapshots: given refs (analyzed when missing) or every cached one.
  const picked: { snapshot: Snapshot; ref: string }[] = [];
  if (opts.refs.length) {
    for (const r of opts.refs) {
      const t0 = Date.now();
      const { snapshot, cached } = await analyzeRef(root, r, { since: opts.since, log, force: opts.force });
      log(`${r} ${snapshot.sha.slice(0, 10)} ${cached ? 'cached' : `analyzed in ${Date.now() - t0}ms`}`);
      if (!picked.some((p) => p.snapshot.sha === snapshot.sha)) picked.push({ snapshot, ref: r });
    }
  } else {
    let headSha = '';
    try {
      headSha = resolveRef(root, 'HEAD').sha;
    } catch {
      // no HEAD commit
    }
    const summaries = listSnapshots(id)
      .filter((s) => s.toolVersion === version)
      .sort((a, b) => (a.sha === headSha ? -1 : b.sha === headSha ? 1 : b.analyzedAt.localeCompare(a.analyzedAt)));
    for (const s of summaries) {
      const snapshot = readSnapshot(id, s.sha, version);
      if (snapshot) picked.push({ snapshot, ref: snapshot.ref });
    }
    if (!picked.length) throw new Error('no cached snapshots for this repo; pass refs to analyze, or run `codeviz analyze` first');
  }

  // Write. Only paths inside `dir` are touched.
  mkdirSync(dir, { recursive: true });
  if (opts.overwrite) {
    for (const name of [...readdirSync(webDir), 'snapshots']) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  cpSync(webDir, dir, { recursive: true });
  const snapDir = path.join(dir, 'snapshots');
  mkdirSync(snapDir, { recursive: true });

  const summaries: SnapshotSummary[] = picked.map(({ snapshot: s, ref }) => ({
    sha: s.sha,
    ref,
    analyzedAt: s.analyzedAt,
    toolVersion: s.toolVersion,
    languages: s.languages,
  }));
  const index = {
    repo: repoName(root),
    repoId: id,
    head: picked[0]!.snapshot.sha,
    snapshots: summaries,
    refs: [],
    worktree: null,
  };
  writeFileSync(path.join(snapDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  for (const { snapshot } of picked) writeFileSync(path.join(snapDir, `${snapshot.sha}.json.gz`), encodeSnapshot(snapshot));

  let pairs = 0;
  const pairsSkipped = picked.length > MAX_COMPARE_REFS;
  if (!pairsSkipped && picked.length > 1) {
    const cmpDir = path.join(snapDir, 'compare');
    mkdirSync(cmpDir, { recursive: true });
    for (const { snapshot: b } of picked) {
      for (const { snapshot: h } of picked) {
        if (b.sha === h.sha) continue;
        // Same as compareRefs, on the snapshots already in hand (no re-analysis on a --since mismatch).
        const diff = diffSnapshots(b, h, compareRenames(root, b.sha, h.sha));
        writeFileSync(path.join(cmpDir, `${b.sha}-${h.sha}.json.gz`), gzipSync(JSON.stringify(diff)));
        pairs++;
      }
    }
  }

  return { dir, snapshots: summaries, pairs, pairsSkipped, bytes: dirBytes(dir) };
}
