import { join } from 'node:path';
import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import type { Snapshot } from '@codeviz/core';
import { analyzeRef } from '../analyze.ts';
import { cacheDir } from '../cache.ts';

export const analyzeUsage = 'codeviz analyze [ref...] [--since <90d|6m|1y|YYYY-MM-DD>] [--json] [--force]';

function summary(s: Snapshot, cached: boolean, ms: number): string {
  const langs = Object.entries(s.languages).map(([l, t]) => `${l}:${t}`).join(',') || 'none';
  const where = s.sha === 'WORKTREE' ? '(not cached: WORKTREE)' : join(cacheDir(s.repoId), `${s.sha}.json.gz`);
  const sha = s.sha === 'WORKTREE' ? 'WORKTREE' : s.sha.slice(0, 10);
  return `${s.ref} ${sha} files=${s.files.length} functions=${s.functions.length} languages=${langs} ${
    cached ? 'cached' : `${ms}ms`
  } ${where}`;
}

export async function analyzeCommand(args: string[]): Promise<number> {
  const refs: string[] = [];
  let since = DEFAULT_SINCE;
  let json = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--force') force = true;
    else if (a === '--since') {
      const v = args[++i];
      if (!v) return fail('--since needs a value');
      since = v;
    } else if (a.startsWith('--since=')) since = a.slice('--since='.length);
    else if (a.startsWith('-')) return fail(`unknown option ${a}\nusage: ${analyzeUsage}`, 2);
    else refs.push(a);
  }
  if (refs.length === 0) refs.push('HEAD');
  try {
    parseSince(since);
  } catch (err) {
    return fail((err as Error).message);
  }

  const out = json ? console.error : console.log;
  const log = (s: string) => console.error(s);
  const snapshots: Snapshot[] = [];
  for (const ref of refs) {
    const t0 = Date.now();
    try {
      const { snapshot, cached } = await analyzeRef(process.cwd(), ref, { since, log, force });
      snapshots.push(snapshot);
      out(summary(snapshot, cached, Date.now() - t0));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  if (json) process.stdout.write(JSON.stringify(snapshots.length === 1 ? snapshots[0] : snapshots) + '\n');
  return 0;
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz analyze: ${msg}`);
  return code;
}
