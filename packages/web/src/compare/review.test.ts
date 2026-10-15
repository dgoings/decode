import { expect, test } from 'bun:test';
import type { FileDelta, FileEntry, Snapshot, SnapshotDiff } from '@codeviz/core';
import { areaOf, levelOf, reviewItems, testCandidates } from './review.ts';

const delta = (path: string, status: FileDelta['status'], extra: Partial<FileDelta> = {}): FileDelta => ({
  path,
  status,
  code: 10,
  loc: 10,
  comments: 0,
  complexitySum: 5,
  complexityMax: 2,
  churnCommits: 0,
  ...extra,
});
const file = (path: string, extra: Partial<FileEntry> = {}): FileEntry => ({ path, code: 50, ...extra });

const head: Snapshot = {
  repo: 'r',
  repoId: 'r',
  origin: '',
  sha: 'h',
  ref: 'h',
  analyzedAt: '',
  toolVersion: '',
  languages: {},
  files: [
    file('packages/web/a.ts', { churn: { commits: 30, authors: 4 } }),
    file('packages/web/a.test.ts'),
    file('packages/web/b.ts'),
    file('packages/cli/c.ts'),
    file('packages/web/d.ts'),
    ...Array.from({ length: 10 }, (_, i) => file(`packages/web/user${i}.ts`)),
  ],
  functions: [],
  modules: [],
  edges: [
    { from: 'packages/web/a.ts', to: 'packages/web/b.ts', kind: 'import', level: 'file' },
    { from: 'packages/web/b.ts', to: 'packages/web/a.ts', kind: 'import', level: 'file' },
    { from: 'packages/web/b.ts', to: 'packages/cli/c.ts', kind: 'import', level: 'file' },
    ...Array.from({ length: 10 }, (_, i) => ({ from: `packages/web/user${i}.ts`, to: 'packages/web/d.ts', kind: 'import', level: 'file' as const })),
  ],
  coupling: [{ a: 'packages/web/b.ts', b: 'packages/web/user0.ts', coChanges: 6 }],
};

const diff: SnapshotDiff = {
  base: { sha: 'b', ref: 'b' },
  head: { sha: 'h', ref: 'h' },
  renames: {},
  files: [
    delta('packages/web/a.ts', 'modified', { head: head.files[0] }),
    delta('packages/web/b.ts', 'modified'),
    delta('packages/web/d.ts', 'modified', { complexitySum: 0 }),
    delta('packages/web/quiet.css', 'modified', { complexitySum: 0 }),
    delta('packages/cli/c.ts', 'unchanged'),
  ],
  functions: [{ file: 'packages/web/a.ts', name: 'parse', status: 'modified', complexity: 9, baseComplexity: 4, headComplexity: 13 }],
  edges: {
    added: [
      { from: 'packages/web/b.ts', to: 'packages/web/a.ts', kind: 'import', level: 'file' },
      { from: 'packages/web/b.ts', to: 'packages/cli/c.ts', kind: 'import', level: 'file' },
    ],
    removed: [],
  },
  totals: {
    code: 0,
    loc: 0,
    files: { added: 0, removed: 0, modified: 4, renamed: 0, unchanged: 1 },
    edges: { added: 2, removed: 0 },
  },
};

const kinds = (items: ReturnType<typeof reviewItems>, path: string) =>
  items.find((i) => i.path === path)!.signals.map((s) => s.kind).sort();

test('flags each risk on the file it belongs to', () => {
  const items = reviewItems(diff, head);
  expect(kinds(items, 'packages/web/a.ts')).toEqual(['complexity', 'hotspot', 'tests']);
  expect(kinds(items, 'packages/web/b.ts')).toEqual(['boundary', 'co-change', 'cycle', 'tests']);
  expect(kinds(items, 'packages/web/d.ts')).toEqual(['fan-in']);
  expect(kinds(items, 'packages/web/quiet.css')).toEqual([]);
});

test('ranks by score, leaves unchanged files out and quiet files last', () => {
  const items = reviewItems(diff, head);
  expect(items.map((i) => i.path)).not.toContain('packages/cli/c.ts');
  expect(items.at(-1)!.path).toBe('packages/web/quiet.css');
  for (let i = 1; i < items.length; i++) expect(items[i - 1]!.score).toBeGreaterThanOrEqual(items[i]!.score);
});

test('a test that changed alongside its source is not flagged', () => {
  const withTest = { ...diff, files: [...diff.files, delta('packages/web/a.test.ts', 'modified')] };
  expect(kinds(reviewItems(withTest, head), 'packages/web/a.ts')).not.toContain('tests');
});

test('helpers', () => {
  expect(testCandidates('src/x.ts')).toEqual(['src/x.test.ts', 'src/x.spec.ts']);
  expect(testCandidates('pkg/x.go')).toEqual(['pkg/x_test.go']);
  expect(areaOf('packages/web/src/a.ts')).toBe('packages/web');
  expect(areaOf('src/a.ts')).toBe('src');
  expect(areaOf('README.md')).toBe('.');
});

test('a test file that imports the source counts as its test', () => {
  const tested = {
    ...head,
    files: [...head.files, file('packages/web/__tests__/b.ts')],
    edges: [...head.edges, { from: 'packages/web/__tests__/b.ts', to: 'packages/web/b.ts', kind: 'import', level: 'file' as const }],
  };
  const b = reviewItems(diff, tested).find((i) => i.path === 'packages/web/b.ts')!;
  expect(b.signals.find((s) => s.kind === 'tests')!.short).toBe('tests not updated');
});

test('one person churning a file is not a hotspot', () => {
  const solo = { ...head, files: head.files.map((f, i) => (i === 0 ? { ...f, churn: { commits: 30, authors: 1 } } : f)) };
  const soloDiff = { ...diff, files: diff.files.map((d, i) => (i === 0 ? { ...d, head: solo.files[0] } : d)) };
  expect(kinds(reviewItems(soloDiff, solo), 'packages/web/a.ts')).not.toContain('hotspot');
});

test('levels band the score', () => {
  expect([levelOf(0), levelOf(2), levelOf(4), levelOf(7)]).toEqual(['none', 'low', 'medium', 'high']);
  const items = reviewItems(diff, head);
  expect(items.find((i) => i.path === 'packages/web/b.ts')!.level).toBe('high');
  expect(items.find((i) => i.path === 'packages/web/quiet.css')!.level).toBe('none');
});
