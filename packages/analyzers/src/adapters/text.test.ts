import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotMeta } from '@codeviz/core';
import { clearAdapters, runAdapters, type AnalyzeContext } from '../registry.ts';
import { registerBuiltinAdapters } from './index.ts';
import { isTextCandidate, textAdapter } from './text.ts';

const ctx: AnalyzeContext = { ref: { sha: '', ref: '' }, since: '', log: () => {} };
const meta: SnapshotMeta = {
  repo: 'r', repoId: 'id', origin: '', sha: 'abc', ref: 'HEAD',
  analyzedAt: '2026-01-01T00:00:00Z', toolVersion: '0',
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeviz-text-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const files: Record<string, string | Buffer> = {
    'index.html': '<html>\n\n<body></body>\n</html>\n', // loc 4, code 3
    'README.md': '# Title\n\ntext\n\n', // loc 4 (trailing blank counts, final newline does not), code 2
    'a.ts': 'export function f(x: number) {\n  if (x) return 1;\n  return 2;\n}\n',
    'bin.dat': Buffer.from([65, 0, 66, 10]),
    'package-lock.json': '{}\n',
    Dockerfile: 'FROM node\n\nRUN true', // loc 3, code 2
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

beforeEach(clearAdapters);

describe('text adapter', () => {
  test('size-only records for unclaimed text files', async () => {
    const snap = await textAdapter.analyze(repo(), ctx);
    const files = [...snap.files!].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(files).toEqual([
      { path: 'Dockerfile', lang: 'text', loc: 3, code: 2 },
      { path: 'README.md', lang: 'md', loc: 4, code: 2 },
      { path: 'index.html', lang: 'html', loc: 4, code: 3 },
    ]);
    expect(snap.languages).toBeUndefined();
  });

  test('isTextCandidate', () => {
    expect(isTextCandidate('src/a.TS')).toBe(false);
    expect(isTextCandidate('x/main.go')).toBe(false);
    expect(isTextCandidate('app.min.js')).toBe(false);
    expect(isTextCandidate('dist/a.js.map')).toBe(false);
    expect(isTextCandidate('sub/yarn.lock')).toBe(false);
    expect(isTextCandidate('styles.css')).toBe(true);
  });

  test('does not clobber grammar adapter records through runAdapters', async () => {
    registerBuiltinAdapters();
    const { snapshot } = await runAdapters(repo(), ctx, meta);
    const a = snapshot.files.filter((f) => f.path === 'a.ts');
    expect(a).toHaveLength(1);
    expect(a[0].lang).toBe('ts');
    expect(a[0].complexity).toBeDefined();
    expect(snapshot.languages).toEqual({ ts: 'baseline' });
  });
});
