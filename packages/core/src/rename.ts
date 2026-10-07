import { execFileSync } from 'node:child_process';

/** Old path -> new path, from git's rename detection between two refs. */
export type RenameMap = Record<string, string>;

/**
 * Parse `git diff -M --name-status -z` output. Records are NUL-separated:
 * `<status>\0<path>\0` or, for renames/copies, `R<score>\0<old>\0<new>\0`.
 * Only `R` records become renames; copies (`C`) keep the original in place.
 */
export function parseRenameStatus(output: string): RenameMap {
  const parts = output.split('\0');
  const map: RenameMap = {};
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const from = parts[i++];
      const to = parts[i++];
      if (status[0] === 'R' && from && to) map[from] = to;
    } else {
      i++; // single-path record
    }
  }
  return map;
}

export function renameMap(root: string, base: string, head: string): RenameMap {
  const out = execFileSync('git', ['diff', '-M', '--name-status', '-z', base, head], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseRenameStatus(out);
}
