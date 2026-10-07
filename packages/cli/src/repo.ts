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

export function originUrl(root: string): string {
  try {
    return git(root, ['remote', 'get-url', 'origin']);
  } catch {
    return '';
  }
}
