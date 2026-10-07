import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeHistory, parseSince } from './history';

test('parseSince', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  expect(parseSince('90d', now).toISOString()).toBe('2026-03-17T00:00:00.000Z');
  expect(parseSince('2w', now).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  expect(parseSince('6m', now).toISOString()).toBe('2025-12-15T00:00:00.000Z');
  expect(parseSince('1y', now).toISOString()).toBe('2025-06-15T00:00:00.000Z');
  expect(parseSince('2024-01-02').toISOString()).toBe('2024-01-02T00:00:00.000Z');
  expect(() => parseSince('soon')).toThrow();
});

test('analyzeHistory: churn, rename following, coupling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeviz-hist-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  const commit = (who: string, msg: string) => {
    git('add', '-A');
    git('-c', `user.name=${who}`, '-c', `user.email=${who}@x.io`, 'commit', '-m', msg);
  };
  const write = (f: string, s: string) => writeFileSync(join(dir, f), s);
  git('init', '-q');
  write('a.txt', 'a1\n'); write('b.txt', 'b1\n'); write('old.txt', 'o\n');
  commit('alice', 'one');
  write('a.txt', 'a2\n'); write('b.txt', 'b2\n');
  commit('bob', 'two');
  write('old.txt', 'o2\n');
  commit('alice', 'three');
  renameSync(join(dir, 'old.txt'), join(dir, 'new.txt'));
  commit('alice', 'rename');
  write('a.txt', 'a3\n'); write('b.txt', 'b3\n');
  commit('alice', 'four');
  const sha = git('rev-parse', 'HEAD').trim();

  const r = analyzeHistory(dir, { sha, since: '1d' });
  expect(r.files).toEqual([
    { path: 'a.txt', churn: { commits: 3, authors: 2 } },
    { path: 'b.txt', churn: { commits: 3, authors: 2 } },
    { path: 'new.txt', churn: { commits: 3, authors: 1 } },
  ]);
  expect(r.coupling).toEqual([{ a: 'a.txt', b: 'b.txt', coChanges: 3 }]);

  const capped = analyzeHistory(dir, { sha, since: '1d', maxFilesPerCommit: 1 });
  expect(capped.coupling).toEqual([]);
});
