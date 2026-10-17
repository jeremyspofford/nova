// Attachments (FR-021): validate type and size with clear errors, store content-addressed blobs
// under `<dataDir>/blobs/attachments/<sha256>` (docs/06 §3), and turn them into model input.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
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
  if (!existsSync(abs)) {
    mkdirSync(join(dataDir, 'blobs', 'attachments'), { recursive: true, mode: 0o700 });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, abs);
  }
  return { sha256, blobPath };
}

/** Read a stored blob; the path must stay inside the data directory. */
export function readAttachmentBlob(dataDir: string, blobPath: string): Buffer {
  try {
    return readFileSync(resolveWithin([dataDir], blobPath));
  } catch {
    throw new NovaError('not_found', 'attachment content is missing');
  }
}

export function attachmentKind(mime: string | null): AttachmentKind {
  if (mime && mime in IMAGE_MAGIC) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}

/** Longest attachment text inlined into a model request. */
export const MAX_INLINE_CHARS = 200_000;
