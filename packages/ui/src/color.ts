// Color helpers for user overrides (FR-010): blend two colors and pick readable text on a fill.
import { contrastRatio, parseHex } from './contrast.ts';

const BLACK = '#000000';
const WHITE = '#ffffff';

export function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Linear blend in sRGB: `weight` is the share of `b` (0 returns `a`, 1 returns `b`). */
export function mixHex(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const w = Math.min(1, Math.max(0, weight));
  return toHex([ar + (br - ar) * w, ag + (bg - ag) * w, ab + (bb - ab) * w]);
}

/** Black or white, whichever reads better on `fill` (used for text on a custom accent). */
export function readableOn(fill: string): string {
  return contrastRatio(BLACK, fill) >= contrastRatio(WHITE, fill) ? BLACK : WHITE;
}
