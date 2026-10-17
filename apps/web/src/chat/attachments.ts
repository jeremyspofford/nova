// Attachment checks and encoding (FR-021). Limits come from @nova/shared so the client rejects
// exactly what the Hub would, with a specific message per file instead of a failed send.
import { ATTACHMENT_LIMITS } from '@nova/shared';
import type { PendingAttachment } from '../services.tsx';

const MIMES: readonly string[] = ATTACHMENT_LIMITS.mimes;
const TEXT_EXTENSIONS: readonly string[] = ATTACHMENT_LIMITS.textExtensions;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * The MIME type to send, or null when the file type is not accepted. Code and text files are
 * accepted by extension, because browsers report them inconsistently (".ts" often arrives as a
 * video type); they are sent as text/plain unless the reported type is already allowed.
 */
export function acceptedMime(file: { name: string; type: string }): string | null {
  const type = file.type.toLowerCase();
  if (MIMES.includes(type)) return type;
  const ext = extension(file.name);
  if (TEXT_EXTENSIONS.includes(ext)) {
    if (ext === '.md') return 'text/markdown';
    if (ext === '.json') return 'application/json';
    if (ext === '.csv') return 'text/csv';
    return 'text/plain';
  }
  return null;
}

export interface Rejection {
  name: string;
  reason: string;
}

/** Split candidate files into accepted ones and per-file rejections, given how many are attached. */
export function checkFiles(
  files: readonly File[],
  alreadyAttached: number,
): { accepted: { file: File; mime: string }[]; rejected: Rejection[] } {
  const accepted: { file: File; mime: string }[] = [];
  const rejected: Rejection[] = [];
  const max = ATTACHMENT_LIMITS.maxCount;
  for (const file of files) {
    const mime = acceptedMime(file);
    if (!mime) {
      rejected.push({
        name: file.name,
        reason: `${file.name} is not a supported file type. Attach images, PDF, text, Markdown, JSON, CSV or code files.`,
      });
    } else if (file.size > ATTACHMENT_LIMITS.maxBytes) {
      rejected.push({
        name: file.name,
        reason: `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(ATTACHMENT_LIMITS.maxBytes)} per file.`,
      });
    } else if (alreadyAttached + accepted.length >= max) {
      rejected.push({
        name: file.name,
        reason: `${file.name} was not added: a message can have up to ${max} attachments.`,
      });
    } else {
      accepted.push({ file, mime });
    }
  }
  return { accepted, rejected };
}

/** Base64 contents of a blob (without the data: URL prefix). */
export function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Base64 of a UTF-8 string (for bundled samples). */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

let seq = 0;

export async function toPending(file: File, mime: string): Promise<PendingAttachment> {
  return {
    id: `att-${++seq}`,
    name: file.name,
    mime,
    size: file.size,
    data: await readAsBase64(file),
  };
}

export function pendingFromText(name: string, mime: string, text: string): PendingAttachment {
  const data = textToBase64(text);
  return { id: `att-${++seq}`, name, mime, size: new TextEncoder().encode(text).length, data };
}
