// Text encoding and widths for PDF output and input (FR-219). Output uses the standard sans-serif
// fonts every PDF reader provides (nothing is embedded), in the WinAnsi encoding; the advance
// widths below are the published metrics of those standard fonts, used only to wrap lines.

/** Advance widths (1/1000 em) of codes 32..126, regular weight. */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Advance widths (1/1000 em) of codes 32..126, bold weight. */
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Unicode → WinAnsi byte for the 0x80-0x9F block (the rest of 0xA0-0xFF is Latin-1). */
const CP1252: [number, number][] = [
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
];
const TO_WINANSI = new Map(CP1252);
const FROM_WINANSI = new Map(CP1252.map(([u, b]) => [b, u]));

/** Widths (regular, bold) of the 0x80-0x9F block. */
const HIGH_WIDTHS: Record<number, [number, number]> = {
  0x80: [556, 556],
  0x82: [222, 278],
  0x84: [333, 500],
  0x85: [1000, 1000],
  0x89: [1000, 1000],
  0x8c: [1000, 1000],
  0x91: [222, 278],
  0x92: [222, 278],
  0x93: [333, 500],
  0x94: [333, 500],
  0x95: [350, 350],
  0x96: [556, 556],
  0x97: [1000, 1000],
  0x99: [1000, 1000],
  0x9c: [944, 944],
};

/** Characters with a close stand-in inside WinAnsi. */
const STAND_INS: Record<string, string> = {
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '―': '—',
  '−': '-',
  '′': "'",
  '″': '"',
  '⁃': '-',
  '→': '->',
  '←': '<-',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '✓': 'v',
  ' ': ' ',
  ' ': ' ',
  '​': '',
  '﻿': '',
};

/**
 * Encode text as WinAnsi bytes; characters with no WinAnsi code become `?` and are counted, so
 * the caller can say so instead of silently dropping them.
 */
export function encodeWinAnsi(text: string): { bytes: number[]; replaced: number } {
  const bytes: number[] = [];
  let replaced = 0;
  for (const ch of text.replace(/\t/g, '    ')) {
    const sub = STAND_INS[ch];
    if (sub !== undefined) {
      for (const c of sub)
        bytes.push(
          c.charCodeAt(0) < 0x100 ? c.charCodeAt(0) : (TO_WINANSI.get(c.charCodeAt(0)) ?? 0x3f),
        );
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) bytes.push(cp);
    else {
      const b = TO_WINANSI.get(cp);
      if (b !== undefined) bytes.push(b);
      else if (cp < 0x20) continue;
      else {
        bytes.push(0x3f);
        replaced++;
      }
    }
  }
  return { bytes, replaced };
}

/** Unicode text of a WinAnsi byte. */
export function decodeWinAnsi(b: number): string {
  const high = FROM_WINANSI.get(b);
  if (high !== undefined) return String.fromCodePoint(high);
  return String.fromCharCode(b);
}

/** Advance width of a WinAnsi byte in 1/1000 em. */
export function glyphWidth(b: number, bold: boolean): number {
  if (b >= 32 && b <= 126) return (bold ? BOLD : REGULAR)[b - 32]!;
  const high = HIGH_WIDTHS[b];
  if (high) return bold ? high[1] : high[0];
  if (b === 0xa0) return 278;
  if (b > 0xa0) {
    // Accented Latin-1 letters advance like their base letter.
    const base = String.fromCharCode(b).normalize('NFD').charCodeAt(0);
    if (base >= 32 && base <= 126) return (bold ? BOLD : REGULAR)[base - 32]!;
  }
  return 556;
}

/** Width of encoded bytes at a font size, in points. */
export function textWidth(bytes: readonly number[], size: number, bold: boolean): number {
  let w = 0;
  for (const b of bytes) w += glyphWidth(b, bold);
  return (w * size) / 1000;
}
