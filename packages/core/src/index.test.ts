import { expect, test } from 'bun:test';
import { name } from './index.ts';

test('core exports its name', () => {
  expect(name).toBe('@codeviz/core');
});
