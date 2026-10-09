// Fixture: leaf module with a CPU-bound function so the sampling profiler sees it.
export function heavy(n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) x = (x + Math.sqrt(i * 7919)) % 1e9;
  return x;
}

export const square = (v: number): number => v * v;
