import type { CommitEntry } from '../data.ts';

/** How many commits the History mode lists per branch (the server's own default). */
export const COMMIT_LIMIT = 50;

const SUBJECT_MAX = 44;

/** A commit date as `9 Oct 2026`, or '' when the commit carries no date. */
export function commitDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One dropdown row: `5d32878 · 9 Oct 2026 · Merge story/m10-view ✓`, the mark meaning "analyzed". */
export function commitLabel(c: CommitEntry, analyzed: boolean): string {
  const subject = c.subject.length > SUBJECT_MAX ? `${c.subject.slice(0, SUBJECT_MAX - 1)}…` : c.subject;
  const parts = [c.sha.slice(0, 7), commitDate(c.date), subject].filter(Boolean);
  return `${parts.join(' · ')}${analyzed ? ' ✓' : ''}`;
}

/**
 * The pair the History mode opens with: the branch tip as head, the commit before it as base.
 * Null when the branch holds one commit, which leaves nothing to compare.
 */
export function defaultPair(commits: CommitEntry[]): { base: string; head: string } | null {
  if (commits.length < 2) return null;
  return { base: commits[1]!.sha, head: commits[0]!.sha };
}

/** True when both shas are in `commits`, so a hash pair belongs to the branch on show. */
export function pairInBranch(commits: CommitEntry[], base: string | null, head: string | null): boolean {
  if (!base || !head) return false;
  const shas = new Set(commits.map((c) => c.sha));
  return shas.has(base) && shas.has(head);
}

/**
 * Index of each sha in a newest-first list. A base that sits above the head in the list is newer
 * than the head, which reverses every delta, so the toolbar says so.
 */
export function baseIsNewer(commits: CommitEntry[], base: string, head: string): boolean {
  const b = commits.findIndex((c) => c.sha === base);
  const h = commits.findIndex((c) => c.sha === head);
  return b >= 0 && h >= 0 && b < h;
}
