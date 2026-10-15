import { execFileSync } from 'node:child_process';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const exists = (root: string, ref: string): boolean => {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * The branch PRs merge into: origin's default branch when the remote says, else the first of
 * main / master / origin/main / origin/master that exists. Null when none does.
 */
export function defaultBranch(root: string): string | null {
  try {
    const full = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = full.replace(/^refs\/remotes\//, '');
    if (exists(root, name)) return name;
  } catch {
    // no origin/HEAD
  }
  return ['main', 'master', 'origin/main', 'origin/master'].find((r) => exists(root, r)) ?? null;
}

export interface PrRange {
  /** Merge-base sha: what the branch started from, so commits that landed on the base since are left out. */
  base: string;
  /** The base branch the merge-base was taken against (for messages). */
  baseRef: string;
  /** Head sha. */
  head: string;
  /** Commits on head that the base does not have (at `mergedIn`'s first parent when set). */
  commits: number;
  /** When head is already merged into the base: the merge commit that brought it in. */
  mergedIn?: string;
  /**
   * Head is a commit inside the base's history that no merge brought in (a squash merge, or a
   * direct commit): the range is that one commit against its parent.
   */
  single?: boolean;
}

/**
 * The merge commit on `baseRef`'s first-parent line that brought `head` in, or null when head
 * reached the base some other way (it was committed there directly, or squash-merged).
 */
function mergeThatBroughtIn(root: string, head: string, baseRef: string): string | null {
  const merges = git(root, ['rev-list', '--first-parent', '--merges', '--ancestry-path', `${head}..${baseRef}`]);
  const oldest = merges.split('\n').filter(Boolean).at(-1);
  if (!oldest) return null;
  // If the base already had head before this merge, head is on the base line itself.
  try {
    git(root, ['merge-base', '--is-ancestor', head, `${oldest}^1`]);
    return null;
  } catch {
    return oldest;
  }
}

/**
 * What a PR from `head` into `base` (default: the default branch) would contain. A branch that
 * was already merged (even if since deleted) is compared with the base as it was just before its
 * merge, which is what its PR showed. Throws with a readable message.
 */
export function prRange(root: string, head = 'HEAD', base?: string): PrRange {
  const baseRef = base ?? defaultBranch(root);
  if (!baseRef) throw new Error('could not find a main or master branch; pass --base <branch>');
  if (!exists(root, baseRef)) throw new Error(`Unknown git ref: ${baseRef}`);
  if (!exists(root, head)) throw new Error(`Unknown git ref: ${head}`);
  let mergeBase: string;
  try {
    mergeBase = git(root, ['merge-base', baseRef, head]);
  } catch {
    throw new Error(`${head} and ${baseRef} have no common history`);
  }
  const headSha = git(root, ['rev-parse', '--verify', `${head}^{commit}`]);
  const count = (from: string) => Number(git(root, ['rev-list', '--count', `${from}..${headSha}`]));
  const commits = count(mergeBase);
  if (commits === 0) {
    const merge = mergeThatBroughtIn(root, headSha, baseRef);
    if (merge) {
      const before = git(root, ['merge-base', `${merge}^1`, headSha]);
      return { base: before, baseRef, head: headSha, commits: count(before), mergedIn: merge };
    }
    // The base's own tip (e.g. `codeviz pr` on main) stays "nothing to review"; an older commit
    // on the base is shown on its own, which for a squash merge is the whole PR.
    const tip = git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    const parent = headSha !== tip && exists(root, `${headSha}^1`) ? git(root, ['rev-parse', `${headSha}^1`]) : null;
    if (parent) return { base: parent, baseRef, head: headSha, commits: 1, single: true };
  }
  return { base: mergeBase, baseRef, head: headSha, commits };
}

export interface MergedBranch {
  /** `merge`: a merge commit; `squash`: a single commit whose subject ends in "(#123)". */
  kind: 'merge' | 'squash';
  /** The merge (or squash) commit on the base branch. */
  merge: string;
  /** Branch tip (the merge's second parent), or the squash commit itself. */
  head: string;
  /** Where the branch left the base: what its PR was compared against. */
  base: string;
  /** Branch name (or PR title) from the merge message; the subject when neither parses. */
  name: string;
  /** PR number when the merge message names one. */
  pr?: number;
  /** Merge time, unix seconds. */
  date: number;
  commits: number;
}

/**
 * Branch name and PR number from a merge subject: GitHub ("Merge pull request #12 from org/branch"),
 * git ("Merge branch 'x' into main", "Merge remote-tracking branch 'origin/x'") and plain "Merge x".
 */
export function parseMergeSubject(subject: string): { name: string; pr?: number } {
  const gh = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (gh) return { name: gh[2]!, pr: Number(gh[1]) };
  const quoted = /^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'/.exec(subject);
  if (quoted) return { name: quoted[1]! };
  const plain = /^Merge (\S+)$/.exec(subject);
  if (plain) return { name: plain[1]! };
  return { name: subject };
}

/** GitHub's squash-merge subject: the PR title followed by "(#123)". */
const SQUASH_RE = /^(.*\S)\s+\(#(\d+)\)$/;

/** How far back along the base's first-parent line to look for merges and squash merges. */
const SCAN = 500;

/**
 * Branches merged into `baseRef`, newest first: merge commits (deleted branches included, their
 * merges remember them) and GitHub squash merges (each is the whole PR as one commit).
 */
export function recentMerges(root: string, baseRef: string, limit = 30): MergedBranch[] {
  const out = git(root, ['log', '--first-parent', `-n${SCAN}`, '--format=%H%x00%P%x00%ct%x00%s', baseRef]);
  const merges: MergedBranch[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    if (merges.length >= limit) break;
    const [merge, parents, date, subject] = line.split('\0') as [string, string, string, string];
    const [first, second] = parents.split(' ');
    if (!first) continue;
    if (!second) {
      const squash = SQUASH_RE.exec(subject);
      if (squash) merges.push({ kind: 'squash', merge, head: merge, base: first, name: squash[1]!, pr: Number(squash[2]), date: Number(date), commits: 1 });
      continue;
    }
    let base: string;
    try {
      base = git(root, ['merge-base', first, second]);
    } catch {
      continue; // unrelated histories
    }
    const commits = Number(git(root, ['rev-list', '--count', `${base}..${second}`]));
    merges.push({ kind: 'merge', merge, head: second, base, ...parseMergeSubject(subject), date: Number(date), commits });
  }
  return merges;
}
