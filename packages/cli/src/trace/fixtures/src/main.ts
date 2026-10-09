// Fixture: browser entry. Runs work() on a timer so coverage and samples change per tick.
import { work } from './util.ts';

let ticks = 0;
const timer = setInterval(() => {
  (globalThis as { fixtureResult?: number }).fixtureResult = work(3);
  if (++ticks >= 200) clearInterval(timer);
}, 50);
