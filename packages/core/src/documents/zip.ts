// Zip packages for the Office formats (FR-219), plugin archives and `.novax` bundles (FR-049,
// FR-117), through fflate. Reading is bounded: before anything is copied or inflated the central
// directory is walked the way fflate walks it, and an archive is refused when it has too many
// entries, when a stored entry's sizes disagree, when the entries' compressed data adds up to
// more than the archive or when two entries share bytes (several directory entries pointing at
// one payload would multiply it). Each entry counts the larger of its two sizes toward the caps,
// and fflate inflates a deflated entry into a buffer of its declared size, so a crafted archive
// cannot expand past the limits. ZIP64 archives are refused: every cap is far below 4 GB.
// Deflate streams outside a zip (PDF content) are inflated in small steps with the same kind of
// cap.
import { Inflate, Unzlib, strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { NovaError } from '@nova/shared';

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 160 * 1024 * 1024,
};

/** The zip local file header signature. */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
  );
}

const damaged = () => new NovaError('validation', 'the file is not a valid zip package');

/**
 * Walk the central directory as fflate's `unzipSync` does (the same end record, entry count and
 * offsets) and refuse a layout that could make it copy or inflate more than the caps allow.
 */
function checkLayout(bytes: Uint8Array, limits: ZipLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const len = bytes.length;
  let e = len - 22;
  if (e < 0) throw damaged();
  for (; u32(e) !== 0x06054b50; --e) if (!e || len - e > 65558) throw damaged();
  if (e >= 20 && u32(e - 20) === 0x07064b50)
    throw new NovaError('validation', 'ZIP64 archives are not supported');
  const count = u16(e + 8);
  if (count > limits.maxEntries) throw new NovaError('validation', 'the file has too many parts');
  let o = u32(e + 16);
  let compressed = 0;
  const spans: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (o + 46 > len || u32(o) !== 0x02014b50) throw damaged();
    const method = u16(o + 10);
    const size = u32(o + 20);
    const originalSize = u32(o + 24);
    const local = u32(o + 42);
    if (size === 0xffffffff || originalSize === 0xffffffff || local === 0xffffffff)
      throw new NovaError('validation', 'ZIP64 archives are not supported');
    // fflate copies `size` bytes of a stored entry whatever `originalSize` says.
    if (method === 0 && size !== originalSize) throw damaged();
    if (local + 30 > len || u32(local) !== 0x04034b50) throw damaged();
    const end = local + 30 + u16(local + 26) + u16(local + 28) + size;
    if (end > len) throw damaged();
    compressed += size;
    spans.push([local, end]);
    o += 46 + u16(o + 28) + u16(o + 30) + u16(o + 32);
  }
  if (compressed > len) throw damaged();
  // No two entries may share bytes: several directory entries for one payload multiply it.
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) throw damaged();
}

/**
 * The entries of a zip archive that `want` accepts (all when omitted); `want` also gets what the
 * entry can cost (the larger of its two sizes), so a caller can skip a large entry instead of
 * refusing the archive. Throws `validation` for a damaged archive or one past the limits.
 */
export function readZip(
  bytes: Uint8Array,
  want: (name: string, cost: number) => boolean = () => true,
  limits: ZipLimits = ZIP_LIMITS,
): Map<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    checkLayout(bytes, limits);
    files = unzipSync(bytes, {
      filter: (f) => {
        if (++entries > limits.maxEntries)
          throw new NovaError('validation', 'the file has too many parts');
        // Whichever size is larger is what this entry can cost.
        const cost = Math.max(f.size, f.originalSize);
        if (f.name.endsWith('/') || !want(f.name, cost)) return false;
        if (cost > limits.maxEntryBytes)
          throw new NovaError('validation', `a part of the file is too large (${f.name})`);
        total += cost;
        if (total > limits.maxTotalBytes)
          throw new NovaError('validation', 'the file unpacks to too much data');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof NovaError) throw err;
    throw new NovaError('validation', 'the file is not a valid zip package');
  }
  return new Map(Object.entries(files));
}

/** Text of a zip entry, or null when it is missing. */
export function entryText(files: Map<string, Uint8Array>, name: string): string | null {
  const data = files.get(name);
  return data ? strFromU8(data) : null;
}

/**
 * Write a zip archive from [path, text or bytes] pairs, in order (the content-types part goes
 * first by convention). `mtime` keeps the output reproducible for a given document date.
 */
export function writeZip(parts: [string, string | Uint8Array][], mtime: Date): Uint8Array {
  const files: Zippable = {};
  for (const [name, data] of parts) files[name] = typeof data === 'string' ? strToU8(data) : data;
  // DOS timestamps start in 1980.
  const t = mtime.getUTCFullYear() < 1980 ? new Date(Date.UTC(1980, 0, 1)) : mtime;
  return zipSync(files, { level: 6, mtime: t });
}

const STEP = 4096;

/**
 * Inflate a deflate stream (`zlib: true` for the zlib wrapper PDF uses) without letting it grow
 * past `max` bytes. Throws `validation` when it would, or when the data is not deflate.
 */
export function inflateBounded(data: Uint8Array, opts: { zlib: boolean; max: number }): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  const onData = (chunk: Uint8Array) => {
    size += chunk.length;
    if (size > opts.max) {
      over = true;
      throw new NovaError('validation', 'a compressed stream expands to too much data');
    }
    chunks.push(chunk);
  };
  const stream = opts.zlib ? new Unzlib(onData) : new Inflate(onData);
  try {
    for (let at = 0; at < data.length; at += STEP) {
      const end = Math.min(at + STEP, data.length);
      stream.push(data.subarray(at, end), end === data.length);
    }
    if (!data.length) stream.push(new Uint8Array(0), true);
  } catch (err) {
    if (over) throw err;
    // A truncated or slightly damaged stream still yields what inflated before the damage.
    if (!chunks.length) throw new NovaError('validation', 'a compressed stream is damaged');
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
