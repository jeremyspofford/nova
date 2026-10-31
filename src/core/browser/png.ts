// A small PNG codec for Nova's own screenshots (review of PR #238, 4): Chromium's PNGs are 8-bit,
// non-interlaced RGB or RGBA. Nova covers regions of a screenshot itself, in its own process, after
// the capture, so a page can't take the cover away. Node's zlib only; no dependency.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Image { width: number; height: number; channels: 3 | 4; data: Buffer }
export interface Rect { x: number; y: number; w: number; h: number }

const SIG = Buffer.from('89504e470d0a1a0a', 'hex');

export function decodePng(buf: Buffer): Image {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG.');
  let at = 8;
  let width = 0, height = 0, channels: 3 | 4 = 4;
  const idat: Buffer[] = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('latin1');
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`A PNG Nova can’t read (depth ${depth}, colour ${color}, interlace ${interlace}).`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels]! : 0;
      const b = prev ? prev[i]! : 0;
      const c = prev && i >= channels ? prev[i - channels]! : 0;
      const x = line[i]!;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`A PNG line filter Nova doesn’t know (${f}).`);
      }
      out[i] = v & 255;
    }
  }
  return { width, height, channels, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(img: Image): Buffer {
  const stride = img.width * img.channels;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = img.channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The regions painted over in one flat grey, opaque. Rectangles are in pixels of the image.
export function cover(png: Buffer, rects: Rect[]): Buffer {
  if (!rects.length) return png;
  const img = decodePng(png);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(img.width, Math.ceil(r.x + r.w)), y1 = Math.min(img.height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * img.channels;
        img.data[i] = 96; img.data[i + 1] = 96; img.data[i + 2] = 96;
        if (img.channels === 4) img.data[i + 3] = 255;
      }
    }
  }
  return encodePng(img);
}
