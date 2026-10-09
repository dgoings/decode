import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { lcovToOverlay } from '../overlay.ts';

export const overlayUsage = 'codeviz overlay lcov <lcov.info> [--out <overlay.json>] [--root <repo>]';

/** `codeviz overlay lcov`: the reference converter from an lcov tracefile to a coverage overlay. */
export async function overlayCommand(args: string[]): Promise<number> {
  const [kind, ...rest] = args;
  if (kind !== 'lcov') return fail(`expected "lcov"\nusage: ${overlayUsage}`, 2);
  let input: string | undefined;
  let out: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--out' || a === '--root') {
      const v = rest[++i];
      if (!v) return fail(`${a} needs a value`);
      if (a === '--out') out = v;
      else root = v;
    } else if (a.startsWith('--out=')) out = a.slice('--out='.length);
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
    else if (a.startsWith('-') || input) return fail(`unexpected argument ${a}\nusage: ${overlayUsage}`, 2);
    else input = a;
  }
  if (!input) return fail(`expected <lcov.info>\nusage: ${overlayUsage}`, 2);
  if (!root) {
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      root = process.cwd();
    }
  }
  let text: string;
  try {
    text = readFileSync(input, 'utf8');
  } catch (err) {
    return fail(`cannot read ${input}: ${(err as Error).message}`);
  }
  const overlay = lcovToOverlay(text, path.resolve(root), process.cwd());
  const json = JSON.stringify(overlay, null, 2) + '\n';
  if (out) {
    writeFileSync(out, json);
    console.error(`codeviz overlay: ${overlay.rows.length} files -> ${out}`);
  } else process.stdout.write(json);
  return 0;
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz overlay: ${msg}`);
  return code;
}
