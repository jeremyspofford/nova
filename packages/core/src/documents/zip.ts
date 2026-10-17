// Zip packages for the Office formats (FR-219), through fflate. Reading is bounded: the entry
// count and the declared sizes are checked before anything is inflated, and fflate inflates each
// entry into a buffer of its declared size, so a crafted archive cannot expand past the limits.
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

/**
 * The entries of a zip archive whose names `want` accepts (all when omitted). Throws
 * `validation` for a damaged archive or one past the limits.
 */
export function readZip(
  bytes: Uint8Array,
  want: (name: string) => boolean = () => true,
  limits: ZipLimits = ZIP_LIMITS,
): Map<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (++entries > limits.maxEntries)
          throw new NovaError('validation', 'the file has too many parts');
        if (f.name.endsWith('/') || !want(f.name)) return false;
        if (f.originalSize > limits.maxEntryBytes)
          throw new NovaError('validation', `a part of the file is too large (${f.name})`);
        total += f.originalSize;
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
