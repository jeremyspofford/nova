// A small PNG writer and reader with no dependency beyond node:zlib (FR-093, FR-075): the mock
// desktop renders its frames with it, and appshots crop a window out of a screen frame. The
// reader handles 8-bit truecolor PNGs (RGB or RGBA, not interlaced), which is what Nova writes;
// anything else is reported as unreadable so callers fall back to the full image.
import { deflateSync, inflateSync } from 'node:zlib';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Decoded frames above this many pixels are refused (a 16k x 16k screen is far beyond any). */
const MAX_PIXELS = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (const b of p) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGB image in memory, top row first. */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, fill: [number, number, number] = [0, 0, 0]) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new RangeError('a raster needs a positive integer size');
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    this.fillRect({ x: 0, y: 0, width, height }, fill);
  }

  /** Fill a rectangle, clipped to the raster. */
  fillRect(r: ScreenRect, rgb: readonly [number, number, number]): void {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(this.width, Math.floor(r.x + r.width));
    const y1 = Math.min(this.height, Math.floor(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      let i = (y * this.width + x0) * 3;
      for (let x = x0; x < x1; x++) {
        this.data[i++] = rgb[0];
        this.data[i++] = rgb[1];
        this.data[i++] = rgb[2];
      }
    }
  }

  /** A one-pixel outline, clipped to the raster. */
  strokeRect(r: ScreenRect, rgb: readonly [number, number, number]): void {
    this.fillRect({ x: r.x, y: r.y, width: r.width, height: 1 }, rgb);
    this.fillRect({ x: r.x, y: r.y + r.height - 1, width: r.width, height: 1 }, rgb);
    this.fillRect({ x: r.x, y: r.y, width: 1, height: r.height }, rgb);
    this.fillRect({ x: r.x + r.width - 1, y: r.y, width: 1, height: r.height }, rgb);
  }

  toPng(): Uint8Array {
    return encodePng(this.width, this.height, this.data, 3);
  }
}

/** Encode 8-bit RGB (channels 3) or RGBA (channels 4) pixels, top row first. */
export function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array,
  channels: 3 | 4,
): Uint8Array {
  const stride = width * channels;
  if (pixels.length !== stride * height) throw new RangeError('pixel data does not match the size');
  // Filter type 0 (none) on every row: flat UI colors compress well without filtering.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type: RGBA or RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // not interlaced
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The size in the IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!b.subarray(0, 8).equals(SIGNATURE) || b.subarray(12, 16).toString('latin1') !== 'IHDR')
    return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
}

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG; null for anything else or a corrupt file. */
export function decodePng(bytes: Uint8Array): DecodedPng | null {
  const size = pngSize(bytes);
  if (!size || size.width * size.height > MAX_PIXELS) return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let channels: 3 | 4 | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.subarray(pos + 4, pos + 8).toString('latin1');
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (data.length !== len) return null;
    if (type === 'IHDR') {
      const depth = data[8];
      const color = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null;
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!channels || !idat.length) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const { width, height } = size;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[row + i - channels]! : 0;
      const up = y > 0 ? out[row - stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? out[row - stride + i - channels]! : 0;
      const x = line[i]!;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((left + up) >> 1);
          break;
        case 4:
          v = x + paeth(left, up, upLeft);
          break;
        default:
          return null;
      }
      out[row + i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Cut a region out of a PNG; null when the PNG cannot be read or the region is empty. */
export function cropPng(bytes: Uint8Array, region: ScreenRect): Uint8Array | null {
  const img = decodePng(bytes);
  if (!img) return null;
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(img.width, Math.floor(region.x + region.width));
  const y1 = Math.min(img.height, Math.floor(region.y + region.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const c = img.channels;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * c;
    out.set(img.pixels.subarray(from, from + w * c), y * w * c);
  }
  return encodePng(w, h, out, c);
}
