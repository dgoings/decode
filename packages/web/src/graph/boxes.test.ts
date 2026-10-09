import { expect, test } from 'bun:test';
import { BOX_MAX, BOX_MIN, boxSize } from './boxes.ts';

test('boxSize: sqrt area scaling, ~1.4 aspect, clamped to min and max sides', () => {
  expect(boxSize(0)).toEqual({ w: 25, h: BOX_MIN });
  const small = boxSize(50);
  const big = boxSize(2000);
  expect(big.w * big.h).toBeGreaterThanOrEqual(10 * small.w * small.h);
  expect(big.w / big.h).toBeCloseTo(1.4, 1);
  expect(boxSize(1e6).w).toBeLessThanOrEqual(BOX_MAX);
  expect(boxSize(1e6, 320).w).toBeLessThanOrEqual(320);
  expect(boxSize(1e6, 320).w).toBeGreaterThan(BOX_MAX);
});
