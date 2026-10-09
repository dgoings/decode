// Preload for `bun --cpu-prof` on servers: Bun only writes the .cpuprofile on a clean exit, and a
// server stopped with Ctrl-C does not exit cleanly. This turns SIGINT/SIGTERM into process.exit(0)
// when the app has no handler of its own. No instrumentation, no file writes.
//
//   bun --cpu-prof --cpu-prof-dir=/tmp/prof --preload=/abs/codeviz/harness/exit-on-signal.ts src/index.tsx
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (process.listenerCount(sig) === 1) process.exit(0);
  });
}
