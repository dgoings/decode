import { execFileSync } from 'node:child_process';
import type { CouplingEntry, FileEntry, Snapshot } from '@codeviz/core';

export const DEFAULT_SINCE = '365d';

/** Parse `<n>d|w|m|y` durations (relative to now) or an ISO date. Throws on invalid input. */
export function parseSince(since: string, now: Date = new Date()): Date {
  const m = /^(\d+)([dwmy])$/.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const d = new Date(now.getTime());
    if (m[2] === 'd') d.setUTCDate(d.getUTCDate() - n);
    else if (m[2] === 'w') d.setUTCDate(d.getUTCDate() - 7 * n);
    else if (m[2] === 'm') d.setUTCMonth(d.getUTCMonth() - n);
    else d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(since.trim())) {
    const d = new Date(since.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`Invalid --since value: "${since}" (use e.g. 90d, 6m, 1y or an ISO date)`);
}

/** Resolve the new path from a numstat path: `old => new` or `dir/{a => b}/x`. */
function renamePair(p: string): { from: string; to: string } | null {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (brace) {
    const join = (mid: string) => (brace[1]! + mid + brace[4]!).replace(/\/\//g, '/');
    return { from: join(brace[2]!), to: join(brace[3]!) };
  }
  const plain = /^(.*) => (.*)$/.exec(p);
  return plain ? { from: plain[1]!, to: plain[2]! } : null;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
}

export function analyzeHistory(
  root: string,
  opts: { sha: string; since: string; maxFilesPerCommit?: number },
): Partial<Snapshot> {
  const maxFiles = opts.maxFilesPerCommit ?? 50;
  const sinceIso = parseSince(opts.since).toISOString();
  const live = new Set(git(root, ['ls-tree', '-r', '--name-only', opts.sha]).split('\n').filter(Boolean));
  const out = git(root, [
    'log', opts.sha, `--since=${sinceIso}`, '--numstat', '--format=%x01%H%x00%aE', '-M',
  ]);

  // git log is newest-first, so a rename seen here aliases older paths to the new one.
  const alias = new Map<string, string>();
  const resolve = (p: string) => alias.get(p) ?? p;
  const commits = new Map<string, Set<string>>();
  const authors = new Map<string, Set<string>>();
  const pairs = new Map<string, number>();

  for (const chunk of out.split('\x01')) {
    if (!chunk) continue;
    const [head, ...lines] = chunk.split('\n');
    const email = head!.split('\0')[1] ?? '';
    const touched = new Set<string>();
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const raw = parts.slice(2).join('\t');
      const r = renamePair(raw);
      let path: string;
      if (r) {
        path = resolve(r.to);
        alias.set(r.from, path);
      } else {
        path = resolve(raw);
      }
      touched.add(path);
    }
    const files = [...touched].filter((p) => live.has(p));
    for (const f of files) {
      let c = commits.get(f);
      if (!c) commits.set(f, (c = new Set()));
      c.add(chunk); // unique per commit
      let a = authors.get(f);
      if (!a) authors.set(f, (a = new Set()));
      a.add(email);
    }
    if (files.length > maxFiles) continue;
    files.sort();
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) {
        const k = `${files[i]}\0${files[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
  }

  const fileEntries: FileEntry[] = [...commits.keys()].sort().map((path) => ({
    path,
    churn: { commits: commits.get(path)!.size, authors: authors.get(path)!.size },
  }));
  const coupling: CouplingEntry[] = [];
  for (const [k, n] of pairs) {
    if (n < 2) continue;
    const [a, b] = k.split('\0');
    coupling.push({ a: a!, b: b!, coChanges: n });
  }
  coupling.sort((x, y) => y.coChanges - x.coChanges || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return { files: fileEntries, coupling };
}
