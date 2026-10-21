// Reads a .zip into { path: Buffer }: stored and deflated entries, from the
// central directory, so archives written with data descriptors work too.
// Limits are checked before anything is inflated, and again while inflating.
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

export function unzip(buf, { maxFiles = 500, maxBytes = 10_000_000 } = {}) {
  const data = Buffer.from(buf);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65_535); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("That isn't a .zip file.");
  const count = data.readUInt16LE(eocd + 10);
  let at = data.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new ZipError(`That .zip has more than ${maxFiles} files.`);
  const out = {};
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw new ZipError('That .zip is damaged.');
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const packed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLen = data.readUInt16LE(at + 28);
    const extraLen = data.readUInt16LE(at + 30);
    const commentLen = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new ZipError('That .zip is encrypted.');
    total += size;
    if (total > maxBytes) throw new ZipError(`That .zip unpacks to more than ${Math.round(maxBytes / 1e6)} MB.`);
    if (data.readUInt32LE(local) !== 0x04034b50) throw new ZipError('That .zip is damaged.');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + packed);
    if (method === 0) out[name] = Buffer.from(raw);
    else if (method === 8) {
      try { out[name] = inflateRawSync(raw, { maxOutputLength: size + 1 }); } catch { throw new ZipError('That .zip is damaged.'); }
      if (out[name].length !== size) throw new ZipError('That .zip is damaged.');
    } else throw new ZipError('That .zip uses a compression Nova can\'t read.');
  }
  return out;
}
