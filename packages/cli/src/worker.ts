import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@codeviz/core';

/**
 * The CLI entry to re-run as a child: the bundle itself (dist/cli.js) when bundled,
 * or src/cli.ts next to this file when running from source under bun.
 */
function cliEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return self.endsWith('.ts') ? path.join(path.dirname(self), 'cli.ts') : self;
}

export interface ChildAnalysis {
  child: ChildProcess;
  result: Promise<{ snapshot: Snapshot; cached: boolean }>;
}

/**
 * Run `codeviz analyze <ref> --json` in a child process so the walker and git history work
 * never block the caller's event loop. The child fills the snapshot cache exactly like the
 * analyze command; the snapshot comes back over stdout (WORKTREE is never cached, so this is
 * how the server gets it). stderr lines (progress, warnings) are passed to `log`.
 */
export function analyzeInChild(
  root: string,
  ref: string,
  opts: { since: string; force?: boolean; log?: (s: string) => void },
): ChildAnalysis {
  const log = opts.log ?? (() => {});
  const args = [cliEntry(), 'analyze', ref, '--json', '--since', opts.since];
  if (opts.force) args.push('--force');
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = new Promise<{ snapshot: Snapshot; cached: boolean }>((resolve, reject) => {
    const out: Buffer[] = [];
    let errTail = '';
    let partial = '';
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => {
      const lines = (partial + c.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) {
        if (!l) continue;
        log(`  [analyze ${ref}] ${l}`);
        errTail = l;
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (partial) {
        log(`  [analyze ${ref}] ${partial}`);
        errTail = partial;
      }
      if (code !== 0) {
        const why = signal ? `interrupted (${signal})` : errTail.replace(/^codeviz analyze: /, '') || `exit code ${code}`;
        return reject(new Error(`analysis of ${ref} failed: ${why}`));
      }
      try {
        const snapshot = JSON.parse(Buffer.concat(out).toString('utf8')) as Snapshot;
        // The child only reuses a cache entry written before it started.
        resolve({ snapshot, cached: Date.parse(snapshot.analyzedAt) < started });
      } catch (err) {
        reject(new Error(`analysis of ${ref} returned unreadable output: ${(err as Error).message}`));
      }
    });
  });
  return { child, result };
}
