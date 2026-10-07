import { execFileSync } from 'node:child_process';
import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import type { FileDelta, Snapshot, SnapshotDiff } from '@codeviz/core';
import { analyzeRef } from '../analyze.ts';
import { compareRefs } from '../compare.ts';
import { resolveRef } from '../refs.ts';
import { openBrowser, startServer, untilSigint } from './serve.ts';

export const compareUsage =
  'codeviz compare <base> <head> [--since <90d|6m|1y|YYYY-MM-DD>] [--json] [--force] [--open] [--limit <n>]';

const short = (sha: string) => (sha === 'WORKTREE' ? 'WORKTREE' : sha.slice(0, 7));
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Plain aligned columns: first column left-aligned, the rest right-aligned. */
function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => r[c]!.length)));
  return all
    .map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ').trimEnd())
    .join('\n');
}

function topBy(files: FileDelta[], key: (f: FileDelta) => number, limit: number): FileDelta[] {
  return files
    .filter((f) => f.status !== 'unchanged' && key(f) !== 0)
    .sort((a, b) => Math.abs(key(b)) - Math.abs(key(a)) || (a.path < b.path ? -1 : 1))
    .slice(0, limit);
}

export function formatDiff(d: SnapshotDiff, limit: number): string {
  const t = d.totals;
  const label = (r: string, f: FileDelta) => (f.oldPath ? `${f.oldPath} -> ${r}` : r);
  const lines = [
    `${d.base.ref} (${short(d.base.sha)}) -> ${d.head.ref} (${short(d.head.sha)})`,
    `files: +${t.files.added} -${t.files.removed} ~${t.files.modified} renamed ${t.files.renamed}  ` +
      `code ${signed(t.code)}  loc ${signed(t.loc)}  edges +${t.edges.added} -${t.edges.removed}`,
    '',
  ];
  const code = topBy(d.files, (f) => f.code, limit);
  lines.push('Biggest code changes');
  lines.push(
    code.length
      ? table(
          ['path', 'status', 'code', 'loc'],
          code.map((f) => [label(f.path, f), f.status, signed(f.code), signed(f.loc)]),
        )
      : '  (none)',
  );
  lines.push('');
  // Sorted by |complexitySum delta|; files whose sum is unchanged but max moved rank by the max delta.
  const cx = topBy(d.files, (f) => f.complexitySum || f.complexityMax, limit);
  lines.push('Biggest complexity changes');
  lines.push(
    cx.length
      ? table(
          ['path', 'complexity sum', 'complexity max'],
          cx.map((f) => [label(f.path, f), signed(f.complexitySum), signed(f.complexityMax)]),
        )
      : '  (none)',
  );
  return lines.join('\n');
}

export async function compareCommand(args: string[]): Promise<number> {
  const refs: string[] = [];
  let since = DEFAULT_SINCE;
  let json = false;
  let force = false;
  let open = false;
  let limit = 15;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--force') force = true;
    else if (a === '--open') open = true;
    else if (a === '--since' || a.startsWith('--since=')) {
      const v = a === '--since' ? args[++i] : a.slice('--since='.length);
      if (!v) return fail('--since needs a value');
      since = v;
    } else if (a === '--limit' || a.startsWith('--limit=')) {
      const v = a === '--limit' ? args[++i] : a.slice('--limit='.length);
      limit = Number(v);
      if (!v || !Number.isInteger(limit) || limit < 1) return fail(`invalid --limit ${v ?? ''}`);
    } else if (a.startsWith('-')) return fail(`unknown option ${a}\nusage: ${compareUsage}`, 2);
    else refs.push(a);
  }
  if (refs.length !== 2) return fail(`expected <base> <head>\nusage: ${compareUsage}`, 2);
  const [base, head] = refs as [string, string];
  try {
    parseSince(since);
  } catch (err) {
    return fail((err as Error).message);
  }

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fail('not inside a git repository');
  }

  const log = (s: string) => console.error(s);
  let diff: SnapshotDiff;
  let worktree: Snapshot | null = null;
  try {
    if (base === 'WORKTREE') throw new Error('WORKTREE can only be the head of a comparison, not the base');
    resolveRef(root, base);
    resolveRef(root, head);
    // Keep the WORKTREE snapshot so --open can hand it to the server instead of re-analyzing.
    if (head === 'WORKTREE') worktree = (await analyzeRef(root, 'WORKTREE', { since, log })).snapshot;
    diff = await compareRefs(root, base, head, { since, log, force, worktree });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (json) process.stdout.write(JSON.stringify(diff) + '\n');
  else console.log(formatDiff(diff, limit));
  if (!open) return 0;

  const started = await startServer({ root, since, port: 4173, log, worktree });
  if (typeof started === 'string') return fail(started);
  const url = `${started.url}/#view=compare&base=${diff.base.sha}&head=${diff.head.sha}`;
  console.error(`codeviz compare: ${url}`);
  openBrowser(url);
  return untilSigint(started.server);
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz compare: ${msg}`);
  return code;
}
