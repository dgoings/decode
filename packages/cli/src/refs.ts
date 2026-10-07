import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ResolvedRef {
  sha: string;
  ref: string;
  kind: 'head' | 'worktree' | 'detached';
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveRef(root: string, ref: string): ResolvedRef {
  if (ref === 'WORKTREE') return { sha: 'WORKTREE', ref, kind: 'worktree' };
  let sha: string;
  try {
    sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
  let headSha: string | undefined;
  try {
    headSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    // no HEAD commit
  }
  return { sha, ref, kind: sha === headSha ? 'head' : 'detached' };
}

export async function withCheckout<T>(
  root: string,
  resolved: ResolvedRef,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  if (resolved.kind !== 'detached') return fn(root);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-'));
  const cleanup = () => {
    try {
      git(root, ['worktree', 'remove', '--force', tmp]);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      // ignore
    }
  };
  const onSigint = () => {
    // Another listener (codeviz serve) owns shutdown and waits for us; our finally does the cleanup.
    if (process.listenerCount('SIGINT') > 1) return;
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    git(root, ['worktree', 'add', '--detach', tmp, resolved.sha]);
    return await fn(tmp);
  } finally {
    process.off('SIGINT', onSigint);
    cleanup();
  }
}
