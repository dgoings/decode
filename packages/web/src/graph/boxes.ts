/** Map view box sizing: area grows with code lines (sqrt scaling), aspect ~1.4:1, clamped sides. */
export const BOX_MIN = 18;
export const BOX_MAX = 160;
const ASPECT = 1.4;
const SCALE = 2; // px of height per sqrt(code line)

export function boxSize(code: number, max = BOX_MAX): { w: number; h: number } {
  const h = Math.min(max / ASPECT, Math.max(BOX_MIN, SCALE * Math.sqrt(Math.max(0, code || 0))));
  return { w: Math.round(h * ASPECT), h: Math.round(h) };
}
