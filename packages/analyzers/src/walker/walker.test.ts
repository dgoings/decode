import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsConfig, listTrackedFiles, loadLanguage, tsConfig, tsLanguages, walkRepo } from './index.ts';

// Lines:      loc 20; blank 5,18 (2); comment lines 1,2,3,6,14,20 (6);
//             comment-only 1,2,3,6,20 (5, line 14 also has code); code = 20 - 2 - 5 = 13.
// classify:   1 base + if(d0) 1 + else-if(d0, same depth as its if) 1 + for-of(d0) 1
//             + inner if(d1) 2 + && 1 + ternary(d0) 1 = 8. `<`, `===`, `>` do not count.
// pick:       1 base + ?? 1 + ?? 1 = 3 (logical operators never nest).
const TS = `/**
 * Header block comment.
 */
import { x } from './x';

// Line comment
export function classify(n: number): string {
  if (n < 0) {
    return 'neg';
  } else if (n === 0) {
    return 'zero';
  }
  for (const i of [1, 2]) {
    if (i > n && n > 0) return 'small'; // trailing
  }
  return n > 100 ? 'big' : 'mid';
}

const pick = (a?: string, b?: string) => a ?? b ?? 'none';
/* one-line block */
`;

// List:   1 + && 1 = 2 (the ternary lives in the nested arrow, so it is not List's).
// render: 1 + ternary 1 = 2.
const TSX = `export function List({ items }: { items: string[] }) {
  const render = (s: string) => (s ? <li>{s}</li> : null);
  return <ul>{items.length > 0 && items.map(render)}</ul>;
}
`;

// loop:  1 + while(d0) 1 + catch(d1, inside the while) 2 + case 1 + case 1 = 6 (default does not count).
// other: function expression named from its object key; complexity 1.
// Lines: loc 13, comment 1 (comment-only), blank 0, code 12.
const JS = `// util
function loop(xs) {
  let t = 0;
  while (t < 10) {
    try { t += xs.pop(); } catch (e) { break; }
  }
  switch (t) {
    case 1: return 'one';
    case 2: return 'two';
    default: return 'many';
  }
}
module.exports = { loop, other: function () { return 1; } };
`;

// Binary content with a .ts extension: loc-only record (2 newline-terminated lines).
const BIN = Buffer.from([0x00, 0x01, 0x0a, 0xff, 0x0a]);

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'codeviz-walker-'));
  writeFileSync(join(root, 'a.ts'), TS);
  writeFileSync(join(root, 'b.tsx'), TSX);
  writeFileSync(join(root, 'c.js'), JS);
  writeFileSync(join(root, 'bin.ts'), BIN);
  writeFileSync(join(root, 'ignored.ts'), 'function nope() {}\n');
  writeFileSync(join(root, 'notes.txt'), 'hello\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

describe('walker', () => {
  test('walks tracked TS/TSX/JS files with exact size and complexity', async () => {
    const root = fixtureRepo();
    const files = listTrackedFiles(root);
    expect(files).not.toContain('ignored.ts');

    const snap = await walkRepo(root, tsLanguages, files);
    expect(snap.languages).toEqual({ ts: 'baseline' });

    const byPath = Object.fromEntries(snap.files!.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['a.ts', 'b.tsx', 'bin.ts', 'c.js']);
    expect(byPath['a.ts']).toEqual({
      path: 'a.ts', lang: 'ts', loc: 20, code: 13, comments: 6,
      complexity: { sum: 11, max: 8, functions: 2 },
    });
    expect(byPath['b.tsx']).toEqual({
      path: 'b.tsx', lang: 'ts', loc: 4, code: 4, comments: 0,
      complexity: { sum: 4, max: 2, functions: 2 },
    });
    expect(byPath['c.js']).toEqual({
      path: 'c.js', lang: 'ts', loc: 13, code: 12, comments: 1,
      complexity: { sum: 7, max: 6, functions: 2 },
    });
    expect(byPath['bin.ts']).toEqual({ path: 'bin.ts', lang: 'ts', loc: 2 });

    const fns = snap.functions!.map((f) => `${f.file}:${f.line}:${f.name}=${f.complexity}`).sort();
    expect(fns).toEqual([
      'a.ts:19:pick=3',
      'a.ts:7:classify=8',
      'b.tsx:1:List=2',
      'b.tsx:2:render=2',
      'c.js:13:other=1',
      'c.js:2:loop=6',
    ]);
  });

  test('grammars load once per wasm', () => {
    expect(loadLanguage(tsConfig)).toBe(loadLanguage(tsConfig));
    expect(loadLanguage(jsConfig)).not.toBe(loadLanguage(tsConfig));
  });
});
