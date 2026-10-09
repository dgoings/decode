import { execFileSync } from 'node:child_process';
import { analyzeHistory, registerBuiltinAdapters, runAdapters } from '@codeviz/analyzers';
import { isNamedRef, mergeSnapshots, type Snapshot, type SnapshotMeta } from '@codeviz/core';
import { readSnapshot, writeSnapshot } from './cache.ts';
import { refName, resolveRef, withCheckout } from './refs.ts';
import { originUrl, repoId, repoName } from './repo.ts';
import { version } from './version.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface AnalyzeOptions {
  since: string;
  log?: (s: string) => void;
  force?: boolean;
}

/** Analyze one ref of the repo containing `root`, using and filling the snapshot cache. */
export async function analyzeRef(
  root: string,
  ref: string,
  opts: AnalyzeOptions,
): Promise<{ snapshot: Snapshot; cached: boolean }> {
  const log = opts.log ?? (() => {});
  root = git(root, ['rev-parse', '--show-toplevel']);
  registerBuiltinAdapters();

  const resolved = resolveRef(root, ref);
  // A dirty HEAD is analyzed from a clean checkout so uncommitted edits never land in the SHA's cache entry.
  if (resolved.kind === 'head' && git(root, ['status', '--porcelain']) !== '') resolved.kind = 'detached';
  const isWorktree = resolved.kind === 'worktree';
  const id = repoId(root);
  const name = refName(root, ref, resolved.sha);

  if (!isWorktree && !opts.force) {
    const hit = readSnapshot(id, resolved.sha, version);
    if (hit && hit.since === opts.since) {
      // The cache is keyed by sha; upgrade a sha/HEAD label to a branch or tag name, never the reverse.
      if (hit.ref !== name && isNamedRef(name, hit.sha) && !isNamedRef(hit.ref, hit.sha)) {
        hit.ref = name;
        writeSnapshot(hit);
      }
      return { snapshot: hit, cached: true };
    }
  }

  const snapshot = await withCheckout(root, resolved, async (dir) => {
    const meta: SnapshotMeta = {
      repo: repoName(root),
      repoId: id,
      origin: originUrl(root),
      sha: resolved.sha,
      ref: name,
      analyzedAt: new Date().toISOString(),
      toolVersion: version,
      since: opts.since,
    };
    const { snapshot: adapterSnapshot, warnings } = await runAdapters(
      dir,
      { ref: resolved, since: opts.since, log, headRoot: root },
      meta,
    );
    for (const w of warnings) log(`warning: ${w}`);
    const history = analyzeHistory(root, { sha: isWorktree ? 'HEAD' : resolved.sha, since: opts.since });
    return mergeSnapshots(meta, [adapterSnapshot, history]);
  });

  if (!isWorktree) writeSnapshot(snapshot);
  return { snapshot, cached: false };
}
