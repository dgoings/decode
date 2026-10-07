import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSnapshots } from '@codeviz/core';
import { listSnapshots, readSnapshot, writeSnapshot } from './cache.ts';
import { originUrl, repoId, repoName } from './repo.ts';

const tmp = mkdtempSync(join(tmpdir(), 'codeviz-'));
process.env.XDG_CACHE_HOME = join(tmp, 'cache');
const repo = join(tmp, 'myrepo');
const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', repo]);
git('commit', '-q', '--allow-empty', '-m', 'one');

test('repoId is stable root sha; name and origin', () => {
  const root = git('rev-list', '--max-parents=0', 'HEAD');
  expect(repoId(repo)).toBe(root);
  git('commit', '-q', '--allow-empty', '-m', 'two');
  expect(repoId(repo)).toBe(root);
  expect(repoName(repo)).toBe('myrepo');
  expect(originUrl(repo)).toBe('');
});

test('cache read/write/list and toolVersion mismatch', () => {
  const id = repoId(repo);
  const meta = { repo: 'myrepo', repoId: id, origin: '', sha: 'abc', ref: 'main', analyzedAt: 't', toolVersion: '1.0.0' };
  expect(readSnapshot(id, 'abc', '1.0.0')).toBeNull();
  writeSnapshot(mergeSnapshots(meta, [{ files: [{ path: 'a.ts', loc: 1 }] }]));
  expect(readSnapshot(id, 'abc', '1.0.0')?.files[0]?.path).toBe('a.ts');
  expect(readSnapshot(id, 'abc', '2.0.0')).toBeNull();
  expect(listSnapshots(id)).toEqual([{ sha: 'abc', ref: 'main', analyzedAt: 't', toolVersion: '1.0.0', languages: {} }]);
});
