// The `.novaexport` container (FR-105, ADR-097 D5): a standard zip written as a stream, every entry
// deflated and described by ZIP64 fields, so an export is not limited to 65,535 files or 4 GiB
// (the Office zip helpers in ../documents/zip.ts build whole archives in memory and have no ZIP64).
// Deflate itself is fflate's; this file only lays out the records (PKWARE APPNOTE 6.3).
//
// Reading goes through the central directory of a file on disk, never through a guessed stream:
// each entry's declared sizes and CRC are checked while it inflates, and inflating stops as soon as
// an entry would grow past what it declared (no zip bombs).
import { closeSync, openSync, readSync, fstatSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { Deflate, Inflate } from 'fflate';
import { NovaError } from '@nova/shared';

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const VERSION = 45; // 4.5: ZIP64
/** Bit 3: sizes follow the data; bit 11: names are UTF-8. */
const FLAGS = 0x0808;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;
const MAX32 = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Written {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/**
 * Writes a zip as a sequence of chunks. Use: `begin(name)` returns an entry; `push` its data in
 * any number of chunks; `finish()` it; then the next entry; `end()` writes the directory. Every
 * call returns the bytes to send next, so the caller decides when to read more input.
 */
export class ZipWriter {
  readonly #mtime: { time: number; date: number };
  readonly #entries: Written[] = [];
  #offset = 0;
  #open = false;

  constructor(mtime: Date = new Date()) {
    this.#mtime = dosTime(mtime);
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.#offset;
  }

  get count(): number {
    return this.#entries.length;
  }

  begin(
    name: string,
    level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
  ): {
    header: Buffer;
    push: (chunk: Uint8Array) => Buffer[];
    finish: () => Buffer[];
  } {
    if (this.#open) throw new Error('the previous zip entry is still open');
    this.#open = true;
    const nameBytes = Buffer.from(name, 'utf8');
    const offset = this.#offset;
    // ZIP64 extra in the local header: the data descriptor carries 8-byte sizes.
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(this.#mtime.time, 10);
    header.writeUInt16LE(this.#mtime.date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(MAX32, 18);
    header.writeUInt32LE(MAX32, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const head = Buffer.concat([header, nameBytes, extra]);
    this.#offset += head.length;

    let crc = 0;
    let size = 0;
    let compressed = 0;
    let out: Buffer[] = [];
    const deflate = new Deflate({ level }, (data) => {
      compressed += data.length;
      out.push(Buffer.from(data));
    });
    const take = () => {
      const o = out;
      out = [];
      for (const b of o) this.#offset += b.length;
      return o;
    };
    return {
      header: head,
      push: (chunk) => {
        if (!chunk.length) return [];
        crc = crc32(chunk, crc);
        size += chunk.length;
        deflate.push(chunk, false);
        return take();
      },
      finish: () => {
        deflate.push(new Uint8Array(0), true);
        const data = take();
        const dd = Buffer.alloc(24);
        dd.writeUInt32LE(SIG_DESCRIPTOR, 0);
        dd.writeUInt32LE(crc >>> 0, 4);
        dd.writeBigUInt64LE(BigInt(compressed), 8);
        dd.writeBigUInt64LE(BigInt(size), 16);
        this.#offset += dd.length;
        this.#entries.push({ name: nameBytes, crc: crc >>> 0, compressed, size, offset });
        this.#open = false;
        return [...data, dd];
      },
    };
  }

  /** The central directory and the end records. */
  end(): Buffer[] {
    if (this.#open) throw new Error('a zip entry is still open');
    const start = this.#offset;
    const out: Buffer[] = [];
    for (const e of this.#entries) {
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.size), 4);
      extra.writeBigUInt64LE(BigInt(e.compressed), 12);
      extra.writeBigUInt64LE(BigInt(e.offset), 20);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE((3 << 8) | VERSION, 4); // made by Unix, 4.5
      h.writeUInt16LE(VERSION, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(METHOD_DEFLATE, 10);
      h.writeUInt16LE(this.#mtime.time, 12);
      h.writeUInt16LE(this.#mtime.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(MAX32, 20);
      h.writeUInt32LE(MAX32, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE((0o100600 << 16) >>> 0, 38);
      h.writeUInt32LE(MAX32, 42);
      out.push(h, e.name, extra);
    }
    const cdSize = out.reduce((n, b) => n + b.length, 0);
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE((3 << 8) | VERSION, 12);
    z64.writeUInt16LE(VERSION, 14);
    z64.writeUInt32LE(0, 16);
    z64.writeUInt32LE(0, 20);
    z64.writeBigUInt64LE(BigInt(this.#entries.length), 24);
    z64.writeBigUInt64LE(BigInt(this.#entries.length), 32);
    z64.writeBigUInt64LE(BigInt(cdSize), 40);
    z64.writeBigUInt64LE(BigInt(start), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(start + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(MAX32, 12);
    eocd.writeUInt32LE(MAX32, 16);
    out.push(z64, loc, eocd);
    for (const b of out) this.#offset += b.length;
    return out;
  }
}

// ---- reading -------------------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

export interface ZipReadLimits {
  maxEntries: number;
  /** Total of the declared uncompressed sizes. */
  maxTotalBytes: number;
}

const damaged = (why: string) =>
  new NovaError('validation', `the archive is damaged: ${why}`, {
    details: { reason: 'archive_damaged' },
  });

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  if (got !== len) throw damaged('it ends early');
  return buf;
}

function safeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged('a size is out of range');
  return Number(v);
}

/** The entries listed in a zip file's central directory. */
export function listZip(path: string, limits: ZipReadLimits): ZipEntry[] {
  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize < 22) throw damaged('it is too short');
    const tailLen = Math.min(fileSize, 65_557);
    const tail = readAt(fd, fileSize - tailLen, tailLen);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        at = i;
        break;
      }
    }
    if (at < 0) throw damaged('its directory is missing');
    let count = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdOffset = tail.readUInt32LE(at + 16);
    const eocdPos = fileSize - tailLen + at;
    if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
      if (eocdPos < 20) throw damaged('its ZIP64 locator is missing');
      const loc = readAt(fd, eocdPos - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw damaged('its ZIP64 locator is missing');
      const z = readAt(fd, safeNumber(loc.readBigUInt64LE(8)), 56);
      if (z.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw damaged('its ZIP64 directory is missing');
      count = safeNumber(z.readBigUInt64LE(32));
      cdSize = safeNumber(z.readBigUInt64LE(40));
      cdOffset = safeNumber(z.readBigUInt64LE(48));
    }
    if (count > limits.maxEntries)
      throw new NovaError('validation', 'the archive has too many entries', {
        details: { reason: 'too_large' },
      });
    if (cdOffset + cdSize > fileSize) throw damaged('its directory is out of range');
    const cd = readAt(fd, cdOffset, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL)
        throw damaged('a directory entry is malformed');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const nameEnd = p + 46 + nameLen;
      if (nameEnd + extraLen + commentLen > cd.length) throw damaged('a directory entry is cut');
      const name = cd.toString('utf8', p + 46, nameEnd);
      // ZIP64 extra: the fields that were 0xFFFFFFFF, in order.
      let e = nameEnd;
      while (e + 4 <= nameEnd + extraLen) {
        const tag = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (tag === 0x0001) {
          let q = e + 4;
          const next = () => {
            if (q + 8 > e + 4 + len) throw damaged('a ZIP64 field is cut');
            const v = safeNumber(cd.readBigUInt64LE(q));
            q += 8;
            return v;
          };
          if (size === MAX32) size = next();
          if (compressedSize === MAX32) compressedSize = next();
          if (offset === MAX32) offset = next();
        }
        e += 4 + len;
      }
      if (method !== METHOD_DEFLATE && method !== METHOD_STORE)
        throw damaged(`entry ${name} uses an unsupported compression`);
      total += size;
      if (total > limits.maxTotalBytes)
        throw new NovaError('validation', 'the archive unpacks to too much data', {
          details: { reason: 'too_large' },
        });
      out.push({ name, method, crc, compressedSize, size, offset });
      p = nameEnd + extraLen + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Inflate one entry, handing its data to `onData` in chunks. Throws `validation` when the data
 * does not match the entry's declared size or CRC, or would grow past the declared size.
 */
export function readZipEntry(
  path: string,
  entry: ZipEntry,
  onData: (chunk: Uint8Array) => void,
): void {
  const fd = openSync(path, 'r');
  try {
    const lh = readAt(fd, entry.offset, 30);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw damaged(`entry ${entry.name} has no header`);
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    // The local header must agree with the directory: same name, same compression.
    const localName = readAt(fd, entry.offset + 30, nameLen).toString('utf8');
    const flags = lh.readUInt16LE(6);
    if (localName !== entry.name || lh.readUInt16LE(8) !== entry.method)
      throw damaged(`entry ${entry.name} does not match its directory entry`);
    const zip64 =
      readAt(fd, entry.offset + 30 + nameLen, extraLen).indexOf(Buffer.from([1, 0])) === 0;
    const start = entry.offset + 30 + nameLen + extraLen;
    let crc = 0;
    let size = 0;
    let over = false;
    const deliver = (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > entry.size) {
        over = true;
        throw damaged(`entry ${entry.name} is larger than it says`);
      }
      crc = crc32(chunk, crc);
      onData(chunk);
    };
    const inflate =
      entry.method === METHOD_DEFLATE
        ? new Inflate((data) => {
            deliver(data);
          })
        : null;
    const STEP = 1024 * 1024;
    let pos = start;
    const end = start + entry.compressedSize;
    try {
      while (pos < end) {
        const len = Math.min(STEP, end - pos);
        const chunk = readAt(fd, pos, len);
        pos += len;
        if (inflate) inflate.push(chunk, pos >= end);
        else deliver(chunk);
      }
      if (inflate && entry.compressedSize === 0) inflate.push(new Uint8Array(0), true);
    } catch (err) {
      if (over || err instanceof NovaError) throw err;
      throw damaged(`entry ${entry.name} does not inflate`);
    }
    if (size !== entry.size || crc >>> 0 !== entry.crc)
      throw damaged(`entry ${entry.name} fails its checksum`);
    // Sizes after the data (bit 3): they must say the same as the directory.
    if (flags & 0x0008) {
      const dd = readAt(fd, end, zip64 ? 24 : 16);
      const at = dd.readUInt32LE(0) === SIG_DESCRIPTOR ? 4 : 0;
      const ddCrc = dd.readUInt32LE(at);
      const ddCompressed = zip64 ? Number(dd.readBigUInt64LE(at + 4)) : dd.readUInt32LE(at + 4);
      const ddSize = zip64 ? Number(dd.readBigUInt64LE(at + 12)) : dd.readUInt32LE(at + 8);
      if (ddCrc !== entry.crc || ddCompressed !== entry.compressedSize || ddSize !== entry.size)
        throw damaged(`entry ${entry.name} does not match its sizes`);
    }
  } finally {
    closeSync(fd);
  }
}
