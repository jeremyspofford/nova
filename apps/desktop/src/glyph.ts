// The tray and window icon (FR-008): an original glyph drawn in code, a ring with a dot on it
// around a center point, so no image asset ships with the shell. macOS gets a template image
// (black on transparent; the OS tints it); other platforms get the glyph on an accent disc. A
// badge marks that something needs input (FR-215). Encoded as PNG with node:zlib.
import { crc32, deflateSync } from 'node:zlib';

export interface GlyphOptions {
  /** Black on transparent, for a macOS menu-bar template image. */
  template?: boolean;
  /** An amber dot at the lower right: something needs input. */
  badge?: boolean;
}

type Rgba = [number, number, number, number];

const ACCENT: Rgba = [79, 70, 229, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const AMBER: Rgba = [245, 158, 11, 255];

/** Coverage of a shape at a pixel from its signed distance (negative inside), one pixel of AA. */
const cover = (d: number) => Math.min(1, Math.max(0, 0.5 - d));

function over(dst: Uint8Array, i: number, [r, g, b, a]: Rgba, alpha: number): void {
  const sa = (a / 255) * alpha;
  if (sa <= 0) return;
  const da = (dst[i + 3] ?? 0) / 255;
  const oa = sa + da * (1 - sa);
  const mix = (s: number, d: number) => (oa === 0 ? 0 : (s * sa + d * da * (1 - sa)) / oa);
  dst[i] = Math.round(mix(r, dst[i] ?? 0));
  dst[i + 1] = Math.round(mix(g, dst[i + 1] ?? 0));
  dst[i + 2] = Math.round(mix(b, dst[i + 2] ?? 0));
  dst[i + 3] = Math.round(oa * 255);
}

/** RGBA pixels of the glyph, `size` × `size`. */
export function drawGlyph(size: number, opts: GlyphOptions = {}): Uint8Array {
  if (!Number.isInteger(size) || size < 8 || size > 1024) throw new RangeError('size 8..1024');
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const ink = opts.template ? BLACK : WHITE;
  const ringR = size * (opts.template ? 0.36 : 0.3);
  const ringW = Math.max(1, size * 0.075);
  const moonR = size * 0.1;
  // The dot sits on the ring at the upper right.
  const angle = -Math.PI / 4;
  const mx = c + Math.cos(angle) * ringR;
  const my = c + Math.sin(angle) * ringR;
  const coreR = size * 0.085;
  const badgeR = size * 0.16;
  const bx = size - badgeR - size * 0.02;
  const by = size - badgeR - size * 0.02;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const r = Math.hypot(fx - c, fy - c);
      if (!opts.template) over(px, i, ACCENT, cover(r - size * 0.48));
      const ring = Math.abs(r - ringR) - ringW / 2;
      // A gap in the ring around the dot keeps the two apart at small sizes.
      const dm = Math.hypot(fx - mx, fy - my);
      const gap = cover(dm - (moonR + ringW));
      over(px, i, ink, cover(ring) * (1 - gap));
      over(px, i, ink, cover(dm - moonR));
      over(px, i, ink, cover(r - coreR));
      if (opts.badge) {
        const db = Math.hypot(fx - bx, fy - by);
        over(px, i, opts.template ? BLACK : WHITE, cover(db - badgeR - Math.max(1, size * 0.04)));
        over(px, i, AMBER, cover(db - badgeR));
      }
    }
  }
  return px;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG (RGBA, 8 bits per channel, no interlace) of `rgba` pixels (PNG spec §11). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) throw new RangeError('pixel data does not match size');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The glyph as PNG bytes. */
export function glyphPng(size: number, opts: GlyphOptions = {}): Buffer {
  return encodePng(drawGlyph(size, opts), size, size);
}
