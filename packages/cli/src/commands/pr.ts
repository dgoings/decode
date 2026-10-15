import { execFileSync } from 'node:child_process';
import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import type { Snapshot, SnapshotDiff } from '@codeviz/core';
import { analyzeRef } from '../analyze.ts';
import { compareRefs } from '../compare.ts';
import { prRange, type PrRange } from '../pr.ts';
import { refName } from '../refs.ts';
import { openBrowser, startServer, untilSigint } from './serve.ts';

export const prUsage =
  'codeviz pr [head] [--base <branch>] [--uncommitted] [--since <90d|6m|1y|YYYY-MM-DD>] [--port <n>] [--no-open] [--force]';

const short = (sha: string) => (sha === 'WORKTREE' ? 'WORKTREE' : sha.slice(0, 7));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Review a branch the way its PR would show it: compare the branch with where it left the base
 * branch (the merge-base, not the base's tip) and open the compare view on "Look here first".
 */
export async function prCommand(args: string[]): Promise<number> {
  let head: string | undefined;
  let base: string | undefined;
  let since = DEFAULT_SINCE;
  let port = 4173;
  let open = true;
  let force = false;
  let uncommitted = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (name: string) => (a === name ? args[++i] : a.slice(name.length + 1));
    if (a === '--no-open') open = false;
    else if (a === '--force') force = true;
    else if (a === '--uncommitted') uncommitted = true;
    else if (a === '--base' || a.startsWith('--base=')) {
      base = value('--base');
      if (!base) return fail('--base needs a value');
    } else if (a === '--since' || a.startsWith('--since=')) {
      const v = value('--since');
      if (!v) return fail('--since needs a value');
      since = v;
    } else if (a === '--port' || a.startsWith('--port=')) {
      const v = value('--port');
      port = Number(v);
      if (!v || !Number.isInteger(port) || port < 1 || port > 65535) return fail(`invalid --port ${v ?? ''}`);
    } else if (a.startsWith('-')) return fail(`unknown option ${a}\nusage: ${prUsage}`, 2);
    else if (head === undefined) head = a;
    else return fail(`expected at most one head ref\nusage: ${prUsage}`, 2);
  }
  if (uncommitted && head) return fail('--uncommitted reviews the working tree; drop the head ref', 2);
  try {
    parseSince(since);
  } catch (err) {
    return fail((err as Error).message);
  }

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fail('not inside a git repository');
  }

  let range: PrRange;
  try {
    range = prRange(root, head ?? 'HEAD', base);
  } catch (err) {
    return fail((err as Error).message);
  }
  const headLabel = uncommitted ? 'your uncommitted changes' : refName(root, head ?? 'HEAD', range.head);
  if (!uncommitted && range.commits === 0) {
    return fail(
      `${headLabel} has no commits that ${range.baseRef} does not already have.\n` +
        `Check out the branch to review, pass it (codeviz pr <branch>), or add --uncommitted.`,
    );
  }

  const log = (s: string) => console.error(s);
  let diff: SnapshotDiff;
  let worktree: Snapshot | null = null;
  try {
    if (uncommitted) worktree = (await analyzeRef(root, 'WORKTREE', { since, log })).snapshot;
    diff = await compareRefs(root, range.base, uncommitted ? 'WORKTREE' : range.head, { since, log, force, worktree });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const t = diff.totals.files;
  const changed = t.added + t.removed + t.modified + t.renamed;
  const commits = uncommitted ? '' : `, ${plural(range.commits, 'commit')}`;
  if (range.single) console.log(`${headLabel} is a commit on ${range.baseRef} (a squash merge, or committed there directly); showing what that one commit changed.`);
  if (range.mergedIn) console.log(`Already merged into ${range.baseRef} by ${short(range.mergedIn)}; comparing with ${range.baseRef} as it was just before that merge.`);
  console.log(
    `Reviewing ${headLabel} against ${range.baseRef} (branched at ${short(range.base)}${commits}): ${plural(changed, 'file')} changed`,
  );
  if (!open) return 0;

  const started = await startServer({ root, since, port, log, worktree });
  if (typeof started === 'string') return fail(started);
  const url = `${started.url}/#view=compare&base=${diff.base.sha}&head=${diff.head.sha}&panel=review`;
  console.log(`codeviz pr: ${url}`);
  openBrowser(url);
  return untilSigint(started.server);
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz pr: ${msg}`);
  return code;
}
