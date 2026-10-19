// Files on channels (M8; FR-110, docs/13 §4). Inbound: voice and video notes are checked here
// (size, and that the bytes are an Ogg or MP4 file as claimed); photos and documents go through
// the upload checks (`prepareAttachments`, FR-021). Outbound: the artifacts an agent's turn made,
// and the artifacts or attachments `channel.send` names, read back from the blob store. Text-like
// files are what the private-to-shared check and the redactor can read; other files cannot be
// checked, so a shared conversation treats them as private (a failed check counts as private).
import { ATTACHMENT_LIMITS, NovaError } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { readAttachmentBlob } from '../attachments.ts';
import type { InboundAttachment } from './adapters/common.ts';

/** The largest inbound file (Nova's upload limit, also what the Telegram Bot API serves). */
export const MAX_CHANNEL_FILE_BYTES = ATTACHMENT_LIMITS.maxBytes;
/** At most this many files go out with one reply or `channel.send`. */
export const MAX_OUTBOUND_FILES = ATTACHMENT_LIMITS.maxCount;

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function tooLarge(name: string, size: number, max = MAX_CHANNEL_FILE_BYTES): NovaError {
  return new NovaError(
    'validation',
    `"${name}" is ${megabytes(size)}; the limit is ${megabytes(max)}`,
    {
      details: { attachment: name, reason: 'size' },
    },
  );
}

/** A voice or video note, checked: not empty, within the cap, and the container it claims. */
export function prepareNote(a: InboundAttachment): { name: string; mime: string; bytes: Buffer } {
  const name =
    a.name
      .replace(/[\\/]/g, '_')
      .replace(/\p{Cc}/gu, '')
      .trim() || 'note';
  const fail = (message: string, reason: string) =>
    new NovaError('validation', message, { details: { attachment: name, reason } });
  if (!a.bytes.length) throw fail(`"${name}" is empty`, 'empty');
  if (a.bytes.length > MAX_CHANNEL_FILE_BYTES) throw tooLarge(name, a.bytes.length);
  if (a.note?.kind === 'voice') {
    // Telegram voice notes are Ogg (Opus).
    if (a.bytes.subarray(0, 4).toString('latin1') !== 'OggS')
      throw fail(`"${name}" does not look like an Ogg voice note`, 'content');
    return { name, mime: 'audio/ogg', bytes: a.bytes };
  }
  // Video notes are MP4: an ISO base media file starts with an `ftyp` box.
  if (a.bytes.subarray(4, 8).toString('latin1') !== 'ftyp')
    throw fail(`"${name}" does not look like an MP4 video note`, 'content');
  return { name, mime: 'video/mp4', bytes: a.bytes };
}

/** The line a turn's text gets for a note it cannot hear. */
export function noteLine(a: InboundAttachment, name: string): string {
  const what = a.note?.kind === 'voice' ? 'Voice note' : 'Video note';
  const s = a.note?.seconds;
  const length = typeof s === 'number' && s > 0 ? ` (${s} s)` : '';
  return `[${what}${length} kept with this chat's files as ${name}. Listening to it is not available yet.]`;
}

/** A file read back for sending. */
export interface StoredFile {
  /** `artifact:<id>` or `attachment:<id>`. */
  ref: string;
  name: string;
  mime: string;
  bytes: Buffer;
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'image/svg+xml',
  'application/javascript',
]);

/** Whether a file is text the private-content check and the redactor can read. */
export function isTextLike(mime: string): boolean {
  const m = mime.split(';')[0]!.trim().toLowerCase();
  return m.startsWith('text/') || TEXT_MIMES.has(m);
}

const EXT_BY_KIND: Record<string, string> = {
  markdown: '.md',
  html: '.html',
  svg: '.svg',
  chart: '.json',
  pdf: '.pdf',
};
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
};
const EXT_BY_LANGUAGE: Record<string, string> = {
  typescript: '.ts',
  javascript: '.js',
  python: '.py',
  json: '.json',
  html: '.html',
  css: '.css',
  shell: '.sh',
  bash: '.sh',
  sql: '.sql',
  rust: '.rs',
  go: '.go',
  yaml: '.yaml',
};

/** A file name for an artifact: its title (cleaned) with an extension that fits its kind. */
export function artifactFileName(a: {
  kind: string;
  title: string | null;
  mime: string;
  language: string | null;
}): string {
  const base =
    (a.title ?? '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || a.kind;
  const mime = a.mime.split(';')[0]!.trim().toLowerCase();
  const ext =
    (a.kind === 'code' && a.language ? EXT_BY_LANGUAGE[a.language.toLowerCase()] : undefined) ??
    EXT_BY_KIND[a.kind] ??
    EXT_BY_MIME[mime] ??
    '';
  return ext && !base.toLowerCase().endsWith(ext) ? `${base}${ext}` : base;
}

interface ArtifactFileRow {
  id: string;
  kind: string;
  title: string | null;
  meta_json: string | null;
  blob_path: string | null;
  mime: string | null;
}

function languageOf(metaJson: string | null): string | null {
  try {
    const m = JSON.parse(metaJson ?? '{}') as { language?: unknown };
    return typeof m.language === 'string' ? m.language : null;
  } catch {
    return null;
  }
}

function artifactFile(dataDir: string, r: ArtifactFileRow): StoredFile | null {
  if (!r.blob_path) return null;
  const mime = r.mime ?? 'application/octet-stream';
  return {
    ref: `artifact:${r.id}`,
    name: artifactFileName({
      kind: r.kind,
      title: r.title,
      mime,
      language: languageOf(r.meta_json),
    }),
    mime: mime.split(';')[0]!.trim(),
    bytes: readAttachmentBlob(dataDir, r.blob_path),
  };
}

/**
 * The artifacts a turn made or changed (their newest version in the turn), oldest first, at most
 * `limit`; `more` counts the rest.
 */
export function turnFiles(
  db: NovaDatabase,
  dataDir: string,
  accountId: string,
  turnId: string,
  limit = MAX_OUTBOUND_FILES,
): { files: StoredFile[]; more: number } {
  const rows = db.raw
    .prepare(
      `SELECT a.id, a.kind, a.title, a.meta_json, v.blob_path, v.mime, v.version
       FROM artifact_version v JOIN artifact a ON a.id = v.artifact_id
       WHERE a.account_id = ? AND v.message_id IN (SELECT id FROM message WHERE turn_id = ?)
       ORDER BY v.created_at, v.rowid`,
    )
    .all(accountId, turnId) as unknown as (ArtifactFileRow & { version: number })[];
  // The newest version of each artifact, in the order the artifacts first appeared (a Map keeps
  // a key's first position when its value is replaced).
  const latest = new Map<string, ArtifactFileRow>();
  for (const r of rows) latest.set(r.id, r);
  const all = [...latest.values()];
  const files: StoredFile[] = [];
  for (const r of all.slice(0, limit)) {
    try {
      const f = artifactFile(dataDir, r);
      if (f) files.push(f);
    } catch {
      // A blob that cannot be read is left out; the artifact stays in Nova.
    }
  }
  return { files, more: Math.max(0, all.length - limit) };
}

/**
 * Files of a thread by id for `channel.send`: artifacts (current version) or attachments of that
 * thread. Anything else is `not_found`, so an agent cannot send another chat's files.
 */
export function threadFiles(
  db: NovaDatabase,
  dataDir: string,
  accountId: string,
  threadId: string,
  ids: readonly string[],
): StoredFile[] {
  if (ids.length > MAX_OUTBOUND_FILES)
    throw new NovaError('validation', `at most ${MAX_OUTBOUND_FILES} files per message`, {
      details: { field: 'files' },
    });
  const out: StoredFile[] = [];
  for (const id of new Set(ids)) {
    const art = db.raw
      .prepare(
        `SELECT id, kind, title, meta_json, blob_path, mime FROM artifact
         WHERE id = ? AND account_id = ? AND thread_id = ?`,
      )
      .get(id, accountId, threadId) as ArtifactFileRow | undefined;
    if (art) {
      const f = artifactFile(dataDir, art);
      if (!f) throw new NovaError('validation', `artifact ${id} has no content to send`);
      out.push(f);
      continue;
    }
    const att = db.raw
      .prepare(
        `SELECT id, name, mime, blob_path FROM attachment a
         WHERE id = ? AND thread_id = ?
           AND EXISTS (SELECT 1 FROM thread t WHERE t.id = a.thread_id AND t.account_id = ?)`,
      )
      .get(id, threadId, accountId) as
      { id: string; name: string; mime: string | null; blob_path: string } | undefined;
    if (!att)
      throw new NovaError('not_found', `no file ${id} in this chat`, {
        details: { field: 'files' },
      });
    out.push({
      ref: `attachment:${att.id}`,
      name: att.name,
      mime: (att.mime ?? 'application/octet-stream').split(';')[0]!.trim(),
      bytes: readAttachmentBlob(dataDir, att.blob_path),
    });
  }
  return out;
}
