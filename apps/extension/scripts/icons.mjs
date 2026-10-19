// Nova's extension icon, drawn here (our own shape, no third-party asset): a blue rounded
// square with a white four-pointed spark, rendered with 4x4 supersampling and written as PNG
// with node:zlib. `node scripts/icons.mjs <dir>` writes icon-16/32/48/128.png into <dir>.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export const ICON_SIZES = [16, 32, 48, 128];
const BLUE = [36, 87, 214];
const WHITE = [255, 255, 255];

/** Inside the rounded square (margin 4 %, corner radius 22 %). */
function inSquare(x, y) {
  const m = 0.04;
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - m - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - m - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Inside the spark: an astroid, |x|^(2/3) + |y|^(2/3) <= R^(2/3). */
function inSpark(x, y) {
  const R = 0.32;
  const k = 2 / 3;
  return Math.abs(x - 0.5) ** k + Math.abs(y - 0.5) ** k <= R ** k;
}

/** RGBA pixels of the icon at `size` x `size`. */
export function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const n = 4;
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      let cover = 0;
      let white = 0;
      for (let a = 0; a < n; a++)
        for (let b = 0; b < n; b++) {
          const x = (i + (a + 0.5) / n) / size;
          const y = (j + (b + 0.5) / n) / size;
          if (!inSquare(x, y)) continue;
          cover++;
          if (inSpark(x, y)) white++;
        }
      const o = (j * size + i) * 4;
      if (!cover) continue;
      const t = white / cover;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BLUE[c] * (1 - t) + WHITE[c] * t);
      px[o + 3] = Math.round((cover / (n * n)) * 255);
    }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A PNG (8-bit RGBA, no interlace) of `rgba` pixels. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      rows,
      y * (width * 4 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const size of ICON_SIZES)
    writeFileSync(join(dir, `icon-${size}.png`), encodePng(size, size, drawIcon(size)));
}

if (import.meta.url === `file://${process.argv[1]}`) writeIcons(process.argv[2] ?? 'dist/icons');
