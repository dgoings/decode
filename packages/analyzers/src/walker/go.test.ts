import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goAdapter } from '../adapters/go.ts';

// loc 21; blank lines 2 and 10 (2); comment lines 3 and 17 (2);
// comment-only: 3 (line 17 also has code); code = 21 - 2 - 1 = 18.
// Max:      1 base + if 1 = 2.
// Classify: 1 base + for 1 + case 1 (depth 1, so 2) + case 2 (depth 1, so 2) + && 1 = 7.
//           `>` and the switch statement itself do not count.
const GO = `package main

// Max returns the larger value.
func Max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func Classify(xs []int, ok bool) string {
	for _, x := range xs {
		switch x {
		case 1:
			return "one"
		case 2:
			_ = ok && x > 0 // trailing
		}
	}
	return "none"
}
`;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeviz-go-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

describe('go adapter', () => {
  test('size and complexity', async () => {
    const dir = repo({ 'main.go': GO });
    expect(goAdapter.detect(dir)).toBe(true);
    const snap = await goAdapter.analyze(dir, { ref: { sha: '', ref: '' }, since: '', log: () => {} });
    expect(snap.languages).toEqual({ go: 'baseline' });
    expect(snap.files).toHaveLength(1);
    const f = snap.files![0];
    expect([f.loc, f.code, f.comments]).toEqual([21, 18, 2]);
    expect(f.complexity).toEqual({ sum: 9, max: 7, functions: 2 });
    const byName = Object.fromEntries(snap.functions!.map((fn) => [fn.name, fn.complexity]));
    expect(byName).toEqual({ Max: 2, Classify: 7 });
  });

  test('detect', () => {
    expect(goAdapter.detect(repo({ 'go.mod': 'module x\n' }))).toBe(true);
    expect(goAdapter.detect(repo({ 'a.txt': 'x' }))).toBe(false);
  });
});
