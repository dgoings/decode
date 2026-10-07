import { expect, test } from 'bun:test';
import { buildHierarchy } from './treemap.ts';

test('buildHierarchy nests by path, floors sizes, skips history-only, merges single-child dirs', () => {
  const tree = buildHierarchy(
    [
      { path: 'README.md', loc: 10 },
      { path: 'src/a.ts', code: 40, loc: 50 },
      { path: 'src/lib/deep/b.ts', code: 0 },
      { path: 'docs/old.md' }, // history-only: no size info
    ],
    'repo',
  );
  expect(tree.name).toBe('repo');
  expect(tree.children!.map((c) => c.name)).toEqual(['README.md', 'src']);
  expect(tree.children![0]!.value).toBe(10);
  const src = tree.children![1]!;
  expect(src.children!.map((c) => [c.name, c.path, c.value])).toEqual([
    ['a.ts', 'src/a.ts', 40],
    ['lib/deep', 'src/lib/deep', undefined],
  ]);
  expect(src.children![1]!.children![0]).toMatchObject({ name: 'b.ts', path: 'src/lib/deep/b.ts', value: 1 });
});
