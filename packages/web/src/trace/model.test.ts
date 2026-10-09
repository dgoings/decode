import { expect, test } from 'bun:test';
import type { TraceTick } from '../data.ts';
import { advance, classifyEdges, decayFactor, emptyHeat, heatAt, runtimeKey } from './model.ts';

const tick = (t: number, n: number): TraceTick => ({ t, files: [['a.ts', n]], edges: [['a.ts', 'b.ts', n]] });

test('advance batches ticks per frame, decays exponentially, and matches heatAt', () => {
  const ticks = [tick(100, 10), tick(200, 10), tick(250, 4), tick(1000, 1)];
  const decay = 500;
  const heat = emptyHeat();
  let cursor = 0;
  let t = 0;
  // ~60fps frames: three ticks land in a handful of frames, each added once.
  for (; t < 300; t += 16) cursor = advance(heat, ticks, cursor, t, t + 16, decay);
  expect(cursor).toBe(3);
  const expected = [tick(100, 10), tick(200, 10), tick(250, 4)].reduce((s, tk) => s + tk.files[0]![1] * decayFactor(t - tk.t, decay), 0);
  expect(heat.files.get('a.ts')!).toBeCloseTo(expected, 6);
  expect(heat.edges.get(runtimeKey('a.ts', 'b.ts'))!).toBeCloseTo(expected, 6);
  expect(heatAt(ticks, t, decay).heat.files.get('a.ts')!).toBeCloseTo(expected, 6);

  // After ~decay ms only ~5% is left; long after, it is dropped entirely.
  const before = heat.files.get('a.ts')!;
  advance(heat, ticks, cursor, t, t + decay, decay);
  expect(heat.files.get('a.ts')! / before).toBeCloseTo(Math.exp(-3), 6);
  advance(heat, [], 0, t + decay, t + 20 * decay, decay);
  expect(heat.files.size).toBe(0);
});

test('classifyEdges splits import edges by calls and finds runtime-only edges', () => {
  const imports = [runtimeKey('a', 'b'), runtimeKey('b', 'c')];
  const runtime = new Map([
    [runtimeKey('a', 'b'), 3],
    [runtimeKey('c', 'b'), 2], // opposite to the import direction: runtime-only
  ]);
  const c = classifyEdges(imports, runtime);
  expect([c.called, c.uncalled, c.runtimeOnly]).toEqual([1, 1, 1]);
  expect([...c.runtimeOnlyKeys]).toEqual([runtimeKey('c', 'b')]);
});
