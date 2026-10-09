// Fixture: middle module calling into math.ts.
import { heavy, square } from './math.ts';

export function work(rounds: number): number {
  let total = 0;
  for (let r = 0; r < rounds; r++) total += heavy(200_000) + square(r);
  return total;
}
