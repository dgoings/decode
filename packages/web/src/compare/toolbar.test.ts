import { expect, test } from 'bun:test';
import { WORKTREE } from '../data.ts';
import { canSwap } from './toolbar.ts';

test('a swap needs two refs, and never moves WORKTREE to the base side', () => {
  expect(canSwap('a', 'b')).toBe(true);
  expect(canSwap('a', WORKTREE)).toBe(false);
  expect(canSwap(WORKTREE, 'b')).toBe(false);
  expect(canSwap(null, 'b')).toBe(false);
  expect(canSwap('a', null)).toBe(false);
});
