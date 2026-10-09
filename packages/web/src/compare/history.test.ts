import { expect, test } from 'bun:test';
import type { CommitEntry } from '../data.ts';
import { baseIsNewer, commitDate, commitLabel, defaultPair, pairInBranch } from './history.ts';

const commit = (sha: string, subject = 's', date = '2026-10-09T12:00:00Z'): CommitEntry => ({
  sha: sha.repeat(40).slice(0, 40),
  subject,
  author: 'a',
  date,
});
const log = [commit('5'), commit('6'), commit('2')];

test('defaultPair takes the tip as head and the commit before it as base', () => {
  expect(defaultPair(log)).toEqual({ base: log[1]!.sha, head: log[0]!.sha });
  expect(defaultPair([log[0]!])).toBeNull();
  expect(defaultPair([])).toBeNull();
});

test('pairInBranch keeps a hash pair only when both commits are in the branch', () => {
  expect(pairInBranch(log, log[2]!.sha, log[0]!.sha)).toBe(true);
  expect(pairInBranch(log, 'f'.repeat(40), log[0]!.sha)).toBe(false);
  expect(pairInBranch(log, null, log[0]!.sha)).toBe(false);
});

test('baseIsNewer flags a reversed pair, by position in the newest-first list', () => {
  expect(baseIsNewer(log, log[0]!.sha, log[2]!.sha)).toBe(true);
  expect(baseIsNewer(log, log[2]!.sha, log[0]!.sha)).toBe(false);
  expect(baseIsNewer(log, 'f'.repeat(40), log[0]!.sha)).toBe(false);
});

test('commitLabel shows the short sha, the date and the subject, and marks an analyzed commit', () => {
  const label = commitLabel(commit('5', 'trace validation'), false);
  expect(label.startsWith('5555555 · ')).toBe(true);
  expect(label.endsWith(' · trace validation')).toBe(true);
  expect(commitLabel(commit('5', 'x'), true).endsWith(' ✓')).toBe(true);
});

test('commitLabel trims a long subject and drops an unparsable date', () => {
  const long = commitLabel(commit('5', 'x'.repeat(80), 'not-a-date'), false);
  expect(long).toBe(`5555555 · ${'x'.repeat(43)}…`);
  expect(commitDate('not-a-date')).toBe('');
});
