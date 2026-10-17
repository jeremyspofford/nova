// Attachments (FR-021): validate type and size with clear errors, store content-addressed blobs
// under `<dataDir>/blobs/attachments/<sha256>` (docs/06 §3), and turn them into model input.
// Blobs (attachments, sources, artifacts) are encrypted at rest once the Hub registers its data
// key (FR-149 baseline, `useBlobKey`); blobs written before that stay readable as plaintext.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { ATTACHMENT_LIMITS, NovaError } from '@nova/shared';
import { resolveWithin } from '@nova/security';

export type AttachmentKind = 'text' | 'image' | 'pdf';

export interface AttachmentInput {
  name: string;
  mime: string;
  /** Base64 contents; a `data:<mime>;base64,` prefix is tolerated. */
  data: string;
}

export interface PreparedAttachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  bytes: Buffer;
}

const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8'),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(name: string, reason: string, message: string): never {
  throw new NovaError('validation', message, { details: { attachment: name, reason } });
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

/** Decode and validate every attachment; the first problem raises a `validation` error. */
export function prepareAttachments(inputs: readonly AttachmentInput[]): PreparedAttachment[] {
  if (inputs.length > ATTACHMENT_LIMITS.maxCount) {
    throw new NovaError(
      'validation',
      `at most ${ATTACHMENT_LIMITS.maxCount} attachments per message`,
      {
        details: { reason: 'count' },
      },
    );
  }
  return inputs.map(prepareOne);
}

function prepareOne(input: AttachmentInput): PreparedAttachment {
  const name =
    input.name
      .replace(/[\\/]/g, '_')
      .replace(/\p{Cc}/gu, '')
      .trim() || 'file';
  let data = input.data;
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  if (comma >= 0) data = data.slice(comma + 1);
  data = data.replace(/\s+/g, '');
  if (data.length % 4 !== 0 || !BASE64.test(data))
    fail(name, 'encoding', `"${name}" could not be read: the upload is not valid base64`);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) fail(name, 'empty', `"${name}" is empty`);
  if (bytes.length > ATTACHMENT_LIMITS.maxBytes) {
    fail(
      name,
      'size',
      `"${name}" is ${formatBytes(bytes.length)}; the limit is ${formatBytes(ATTACHMENT_LIMITS.maxBytes)}`,
    );
  }
  const mime = input.mime.split(';')[0]!.trim().toLowerCase();
  const ext = extname(name).toLowerCase();

  const image = IMAGE_MAGIC[mime];
  if (image) {
    if (!image(bytes)) fail(name, 'content', `"${name}" does not look like a ${mime} image`);
    return { name, mime, kind: 'image', bytes };
  }
  if (mime === 'application/pdf') {
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
      fail(name, 'content', `"${name}" does not look like a PDF`);
    return { name, mime, kind: 'pdf', bytes };
  }
  // Text and code are accepted by extension whatever the browser reported (a .ts file often
  // arrives as video/mp2t), but only when the bytes really are text.
  const byExtension = (ATTACHMENT_LIMITS.textExtensions as readonly string[]).includes(ext);
  if (TEXT_MIMES.has(mime) || byExtension) {
    if (!isText(bytes)) fail(name, 'content', `"${name}" is not UTF-8 text`);
    const textMime = TEXT_MIMES.has(mime) || mime.startsWith('text/') ? mime : 'text/plain';
    return { name, mime: textMime, kind: 'text', bytes };
  }
  return fail(
    name,
    'type',
    `"${name}" is not a supported file type (${mime || 'unknown'}). Attach images, PDFs, text, Markdown, JSON or code files.`,
  );
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface StoredBlob {
  sha256: string;
  /** Relative to the data directory. */
  blobPath: string;
}

/** Content-addressed write; identical uploads share one blob. */
export function writeAttachmentBlob(dataDir: string, bytes: Buffer): StoredBlob {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const blobPath = `blobs/attachments/${sha256}`;
  const abs = join(dataDir, blobPath);
  const key = keyrings.get(resolve(dataDir))?.current ?? null;
  if (existsSync(abs)) {
    // The same content written before encryption was on: seal it now.
    if (key && !hasMagic(readHead(abs))) writeAtomic(abs, seal(key, sha256, bytes));
    return { sha256, blobPath };
  }
  mkdirSync(join(dataDir, 'blobs', 'attachments'), { recursive: true, mode: 0o700 });
  writeAtomic(abs, key ? seal(key, sha256, bytes) : bytes);
  return { sha256, blobPath };
}

/** Read a stored blob; the path must stay inside the data directory. */
export function readAttachmentBlob(dataDir: string, blobPath: string): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(resolveWithin([dataDir], blobPath));
  } catch {
    throw new NovaError('not_found', 'attachment content is missing');
  }
  return unseal(dataDir, basename(blobPath), raw);
}

// ---- encryption at rest (FR-149 baseline, docs/12 §5) -------------------------------------------
//
// A sealed blob is MAGIC | key id (8) | nonce (12) | tag (16) | ChaCha20-Poly1305 ciphertext,
// with the header and the blob's file name (its plaintext SHA-256) as associated data, so a
// blob cannot be swapped for another. The magic starts with a NUL byte, which text attachments
// never contain; a legacy plaintext blob that still happens to start with it is recognised by
// its content hash.

const MAGIC = Buffer.from([0x00, 0x4e, 0x56, 0x42, 0x01]);
const KEY_ID = 8;
const NONCE = 12;
const TAG = 16;
const HEADER = MAGIC.length + KEY_ID;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface BlobKey {
  id: Buffer;
  key: Buffer;
}
interface Keyring {
  current: BlobKey | null;
  /** Every key registered for the directory, by id, so older blobs stay readable. */
  all: Map<string, Buffer>;
}
const keyrings = new Map<string, Keyring>();

function keyId(key: Buffer): Buffer {
  return createHash('sha256').update('nova-blob-key\0').update(key).digest().subarray(0, KEY_ID);
}

/**
 * Register the Hub data key for a data directory: new blobs there are sealed with it. `null`
 * stops sealing new blobs; keys stay registered so existing blobs remain readable.
 */
export function useBlobKey(dataDir: string, key: Buffer | null): void {
  const dir = resolve(dataDir);
  const ring = keyrings.get(dir) ?? { current: null, all: new Map<string, Buffer>() };
  keyrings.set(dir, ring);
  if (!key) {
    ring.current = null;
    return;
  }
  if (key.length !== 32) throw new TypeError('a blob key is 32 bytes');
  const entry = { id: keyId(key), key: Buffer.from(key) };
  ring.all.set(entry.id.toString('hex'), entry.key);
  ring.current = entry;
}

/** Whether new blobs in this data directory are encrypted. */
export function blobEncryption(dataDir: string): boolean {
  return !!keyrings.get(resolve(dataDir))?.current;
}

function hasMagic(head: Buffer): boolean {
  return head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);
}

function readHead(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(MAGIC.length);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(abs: string, data: Buffer): void {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, abs);
}

function seal(key: BlobKey, name: string, plain: Buffer): Buffer {
  const header = Buffer.concat([MAGIC, key.id]);
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('chacha20-poly1305', key.key, nonce, { authTagLength: TAG });
  c.setAAD(Buffer.concat([header, Buffer.from(name, 'utf8')]), { plaintextLength: plain.length });
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([header, nonce, c.getAuthTag(), body]);
}

function unseal(dataDir: string, name: string, raw: Buffer): Buffer {
  if (!hasMagic(raw)) return raw;
  const addressed = SHA256_HEX.test(name);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  if (addressed && sha(raw) === name) return raw;
  const corrupt = () =>
    new NovaError('server_error', 'attachment content failed its integrity check');
  if (raw.length < HEADER + NONCE + TAG) throw corrupt();
  const id = raw.subarray(MAGIC.length, HEADER).toString('hex');
  const key = keyrings.get(resolve(dataDir))?.all.get(id);
  if (!key)
    throw new NovaError(
      'server_error',
      'attachment content is encrypted with a key this Hub does not have',
    );
  let plain: Buffer;
  try {
    const d = createDecipheriv('chacha20-poly1305', key, raw.subarray(HEADER, HEADER + NONCE), {
      authTagLength: TAG,
    });
    d.setAAD(Buffer.concat([raw.subarray(0, HEADER), Buffer.from(name, 'utf8')]), {
      plaintextLength: raw.length - HEADER - NONCE - TAG,
    });
    d.setAuthTag(raw.subarray(HEADER + NONCE, HEADER + NONCE + TAG));
    plain = Buffer.concat([d.update(raw.subarray(HEADER + NONCE + TAG)), d.final()]);
  } catch {
    throw corrupt();
  }
  if (addressed && sha(plain) !== name) throw corrupt();
  return plain;
}

export function attachmentKind(mime: string | null): AttachmentKind {
  if (mime && mime in IMAGE_MAGIC) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}

/** Longest attachment text inlined into a model request. */
export const MAX_INLINE_CHARS = 200_000;
