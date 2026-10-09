import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function repoId(root: string): string {
  return git(root, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]!;
}

export function repoName(root: string): string {
  return basename(git(root, ['rev-parse', '--show-toplevel']));
}

/** Drop user:password@ from URL-style remotes (tokens in https remotes). scp-style user@host:path is left alone. */
export function redactOrigin(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function originUrl(root: string): string {
  try {
    return redactOrigin(git(root, ['remote', 'get-url', 'origin']));
  } catch {
    return '';
  }
}
