// Fixture: CPU-bound script for `bun --cpu-prof` and preload overhead timing.
import { work } from './src/util.ts';

const t0 = performance.now();
let sum = 0;
for (let i = 0; i < 40; i++) sum += work(5);
console.log(`bench: ${(performance.now() - t0).toFixed(0)} ms (${sum > 0 ? 'ok' : 'zero'})`);
