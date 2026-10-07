import { beforeEach, expect, test } from 'bun:test';
import type { SnapshotMeta } from '@codeviz/core';
import { clearAdapters, registerAdapter, runAdapters, type AnalyzeContext } from './registry.ts';

const ctx: AnalyzeContext = { ref: { sha: 'abc', ref: 'HEAD' }, since: '90d', log: () => {} };
const meta: SnapshotMeta = {
  repo: 'r', repoId: 'id', origin: '', sha: 'abc', ref: 'HEAD',
  analyzedAt: '2026-01-01T00:00:00Z', toolVersion: '0',
};

beforeEach(clearAdapters);

test('merges partials from multiple adapters for the same file', async () => {
  registerAdapter({
    name: 'a', detect: () => true,
    analyze: async () => ({ languages: { ts: 'precise' }, files: [{ path: 'x.ts', loc: 10 }] }),
  });
  registerAdapter({
    name: 'b', detect: () => true,
    analyze: async () => ({ languages: { py: 'baseline' }, files: [{ path: 'x.ts', complexity: { sum: 3, max: 2, functions: 2 } }] }),
  });
  const { snapshot, warnings } = await runAdapters('/r', ctx, meta);
  expect(warnings).toEqual([]);
  expect(snapshot.languages).toEqual({ ts: 'precise', py: 'baseline' });
  expect(snapshot.files).toEqual([{ path: 'x.ts', loc: 10, complexity: { sum: 3, max: 2, functions: 2 } }]);
});

test('warns when no adapter matches', async () => {
  registerAdapter({ name: 'a', detect: () => false, analyze: async () => ({}) });
  const { snapshot, warnings } = await runAdapters('/r', ctx, meta);
  expect(warnings.length).toBe(1);
  expect(snapshot.files).toEqual([]);
  expect(snapshot.edges).toEqual([]);
});

test('adapter failure names the adapter', async () => {
  registerAdapter({ name: 'boom', detect: () => true, analyze: async () => { throw new Error('bad'); } });
  await expect(runAdapters('/r', ctx, meta)).rejects.toThrow('adapter boom failed: bad');
});
