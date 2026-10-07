import { execFileSync } from 'node:child_process';
import { diffSnapshots, parseRenameStatus, renameMap, type RenameMap, type Snapshot, type SnapshotDiff } from '@codeviz/core';
import { analyzeRef, type AnalyzeOptions } from './analyze.ts';
import { resolveRef } from './refs.ts';

export interface CompareOptions extends AnalyzeOptions {
  /** An already-analyzed WORKTREE snapshot to use when head is `WORKTREE` (the server's in-memory one). */
  worktree?: Snapshot | null;
}

/**
 * Renames between a commit and the head side. For a `WORKTREE` head this is
 * `git diff -M <base>` against the working tree, which covers committed and
 * uncommitted renames of tracked files in one call; a rename whose new path is
 * still untracked (plain `mv` without `git add`) is not detected and shows up
 * as removed + added.
 */
export function compareRenames(root: string, baseSha: string, headSha: string): RenameMap {
  try {
    if (headSha !== 'WORKTREE') return renameMap(root, baseSha, headSha);
    const out = execFileSync('git', ['diff', '-M', '--name-status', '-z', baseSha], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseRenameStatus(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`Could not compute renames between ${baseSha} and ${headSha}: ${msg}`);
  }
}

/** Analyze both refs (cache hits when possible) and diff them. `WORKTREE` is allowed as head only. */
export async function compareRefs(root: string, base: string, head: string, opts: CompareOptions): Promise<SnapshotDiff> {
  if (base === 'WORKTREE') throw new Error('WORKTREE can only be the head of a comparison, not the base');
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  // Validate both refs before spending time analyzing either.
  resolveRef(root, base);
  resolveRef(root, head);
  const { since, log, force } = opts;
  const b = (await analyzeRef(root, base, { since, log, force })).snapshot;
  const h =
    head === 'WORKTREE' && opts.worktree ? opts.worktree : (await analyzeRef(root, head, { since, log, force })).snapshot;
  return diffSnapshots(b, h, compareRenames(root, b.sha, h.sha));
}
