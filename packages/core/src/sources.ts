// Project sources (FR-040): files and pasted text a project's chats can draw on. Adding a source
// stores its bytes as a blob and indexes it in the background, one at a time: pending → indexing
// → ready (chunks in FTS5) or error. Text types only in M2. Chats in the project retrieve the
// best-matching chunks for the user's message; the excerpts used become citations.
import { extname } from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ATTACHMENT_LIMITS,
  NovaError,
  uuidv7,
  type addSourceSchema,
  type SourceStatus,
  type SourceView,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { readAttachmentBlob, writeAttachmentBlob } from './attachments.ts';
import type { EventSink } from './events.ts';

const { source, project } = schema;

export type SourceRow = typeof source.$inferSelect;
export type AddSourceRequest = z.infer<typeof addSourceSchema>;

/** One retrieved passage, numbered as it appears in the model context. */
export interface SourceExcerpt {
  idx: number;
  sourceId: string;
  name: string;
  text: string;
}

export const SOURCE_LIMITS = {
  maxBytes: ATTACHMENT_LIMITS.maxBytes,
  chunkChars: 1_500,
  overlapChars: 200,
  topK: 5,
  maxContextChars: 6_000,
} as const;

export const UNSUPPORTED_SOURCE = 'This file type cannot be indexed yet';

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface SourceServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  /** Hub data directory; source bytes are content-addressed blobs (docs/06 §3). */
  dataDir: string;
  log?: Logger;
  now?: () => Date;
}

export class SourceService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #queue: string[] = [];
  #worker: Promise<void> | null = null;
  #stopped = false;

  constructor(opts: SourceServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#log = opts.log ?? new Logger({ module: 'core.sources', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
  }

  async list(accountId: string, projectId: string): Promise<SourceView[]> {
    await this.#project(accountId, projectId);
    const rows = await this.#db.orm
      .select()
      .from(source)
      .where(and(eq(source.projectId, projectId), isNull(source.deletedAt)))
      .orderBy(asc(source.createdAt), asc(source.id));
    return rows.map(toSourceView);
  }

  async add(accountId: string, projectId: string, req: AddSourceRequest): Promise<SourceView> {
    await this.#project(accountId, projectId);
    const name = cleanName(req.name);
    let bytes: Buffer;
    let mime: string;
    if (req.kind === 'text') {
      bytes = Buffer.from(req.text, 'utf8');
      mime = extname(name).toLowerCase() === '.md' ? 'text/markdown' : 'text/plain';
    } else {
      bytes = decodeBase64(name, req.data);
      mime = req.mime.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
    }
    if (bytes.length === 0)
      throw new NovaError('validation', `"${name}" is empty`, { details: { reason: 'empty' } });
    if (bytes.length > SOURCE_LIMITS.maxBytes) {
      throw new NovaError('validation', `"${name}" is larger than the 20 MB source limit`, {
        details: { reason: 'size' },
      });
    }
    const blob = writeAttachmentBlob(this.#dataDir, bytes);
    const now = this.#now().toISOString();
    const row: SourceRow = {
      id: uuidv7(),
      accountId,
      projectId,
      name,
      mime,
      size: bytes.length,
      sha256: blob.sha256,
      blobPath: blob.blobPath,
      status: 'pending',
      error: null,
      chunkCount: 0,
      indexedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(source).values(row);
      await this.#db.orm.update(project).set({ updatedAt: now }).where(eq(project.id, projectId));
    });
    await this.#emitStatus(row, 'pending', null);
    this.#enqueue(row.id);
    return toSourceView(row);
  }

  async reindex(accountId: string, id: string): Promise<SourceView> {
    const row = await this.#row(accountId, id);
    const now = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.orm
        .update(source)
        .set({ status: 'pending', error: null, updatedAt: now })
        .where(eq(source.id, id)),
    );
    await this.#emitStatus(row, 'pending', null);
    this.#enqueue(id);
    return toSourceView({ ...row, status: 'pending', error: null, updatedAt: now });
  }

  /** Soft delete; its chunks leave retrieval at once. */
  async remove(accountId: string, id: string): Promise<void> {
    await this.#row(accountId, id);
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM source_chunk WHERE source_id = ?').run(id);
      this.#db.raw
        .prepare('UPDATE source SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, id);
    });
  }

  /** Re-queue sources left pending or indexing by a restart. */
  async recover(): Promise<number> {
    const now = this.#now().toISOString();
    const rows = await this.#db.transaction(() => {
      const ids = this.#db.raw
        .prepare(
          `SELECT id FROM source WHERE status IN ('pending', 'indexing') AND deleted_at IS NULL
           ORDER BY created_at, id`,
        )
        .all() as { id: string }[];
      this.#db.raw
        .prepare(
          "UPDATE source SET status = 'pending', updated_at = ? WHERE status = 'indexing' AND deleted_at IS NULL",
        )
        .run(now);
      return ids;
    });
    for (const r of rows) this.#enqueue(r.id);
    return rows.length;
  }

  /** Wait until the indexing queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  /** Stop taking work; the item being indexed finishes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#queue.length = 0;
    await this.idle();
  }

  /**
   * The best-matching ready chunks of a project's sources for `query`: at most 5 and 6,000
   * characters, numbered from 1.
   */
  retrieve(accountId: string, projectId: string, query: string): SourceExcerpt[] {
    const fts = orQuery(query);
    if (!fts) return [];
    const rows = this.#db.raw
      .prepare(
        `SELECT c.source_id AS sourceId, s.name AS name, c.text AS text
         FROM source_chunk_fts
         JOIN source_chunk c ON c.seq = source_chunk_fts.rowid
         JOIN source s ON s.id = c.source_id
         WHERE source_chunk_fts MATCH ?
           AND s.project_id = ? AND s.account_id = ? AND s.status = 'ready' AND s.deleted_at IS NULL
         ORDER BY bm25(source_chunk_fts), c.seq
         LIMIT ?`,
      )
      .all(fts, projectId, accountId, SOURCE_LIMITS.topK) as {
      sourceId: string;
      name: string;
      text: string;
    }[];
    const out: SourceExcerpt[] = [];
    let budget: number = SOURCE_LIMITS.maxContextChars;
    for (const r of rows) {
      if (budget < 200) break;
      const text = r.text.length > budget ? r.text.slice(0, budget) : r.text;
      budget -= text.length;
      out.push({ idx: out.length + 1, sourceId: r.sourceId, name: r.name, text });
    }
    return out;
  }

  // ---- indexing -------------------------------------------------------------------------

  #enqueue(id: string): void {
    if (this.#stopped) return;
    if (!this.#queue.includes(id)) this.#queue.push(id);
    if (this.#worker) return;
    this.#worker = this.#drain().finally(() => {
      this.#worker = null;
    });
  }

  async #drain(): Promise<void> {
    for (let id = this.#queue.shift(); id; id = this.#queue.shift()) {
      try {
        await this.#index(id);
      } catch (err) {
        this.#log.warn('source indexing failed', { err, sourceId: id });
      }
    }
  }

  async #index(id: string): Promise<void> {
    const stamp = this.#now().toISOString();
    const claimed = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare(
            `UPDATE source SET status = 'indexing', updated_at = ?
             WHERE id = ? AND status = 'pending' AND deleted_at IS NULL`,
          )
          .run(stamp, id).changes,
    );
    if (!claimed) return;
    const row = (await this.#db.orm.select().from(source).where(eq(source.id, id)).limit(1))[0];
    if (!row) return;
    await this.#emitStatus(row, 'indexing', null);

    let chunks: string[] | null = null;
    let error: string | null = null;
    try {
      const bytes = readAttachmentBlob(this.#dataDir, row.blobPath);
      if (!isTextSource(row.name, row.mime)) error = UNSUPPORTED_SOURCE;
      else {
        const text = decodeUtf8(bytes);
        if (text === null) error = 'This file is not UTF-8 text';
        else chunks = chunkText(text);
      }
    } catch {
      error = 'The file content is missing';
    }

    const now = this.#now().toISOString();
    // Apply only if nothing changed meanwhile (a reindex or delete restarts or drops the work).
    const applied = await this.#db.transaction(() => {
      const raw = this.#db.raw;
      const live = raw
        .prepare(
          "SELECT 1 AS x FROM source WHERE id = ? AND status = 'indexing' AND updated_at = ? AND deleted_at IS NULL",
        )
        .get(id, stamp);
      if (!live) return false;
      raw.prepare('DELETE FROM source_chunk WHERE source_id = ?').run(id);
      if (chunks) {
        const insert = raw.prepare(
          'INSERT INTO source_chunk (source_id, idx, text, created_at) VALUES (?, ?, ?, ?)',
        );
        chunks.forEach((c, i) => insert.run(id, i, c, now));
        raw
          .prepare(
            "UPDATE source SET status = 'ready', error = NULL, chunk_count = ?, indexed_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(chunks.length, now, now, id);
      } else {
        raw
          .prepare(
            "UPDATE source SET status = 'error', error = ?, chunk_count = 0, updated_at = ? WHERE id = ?",
          )
          .run(error, now, id);
      }
      return true;
    });
    if (applied) await this.#emitStatus(row, chunks ? 'ready' : 'error', chunks ? null : error);
  }

  async #emitStatus(row: SourceRow, status: SourceStatus, error: string | null): Promise<void> {
    const payload: Record<string, unknown> = {
      sourceId: row.id,
      projectId: row.projectId,
      status,
    };
    if (error) payload.error = error;
    await this.#events.emit({
      name: 'source.status.changed',
      accountId: row.accountId,
      payload,
    });
  }

  async #project(accountId: string, projectId: string): Promise<void> {
    const rows = await this.#db.orm
      .select({ id: project.id })
      .from(project)
      .where(
        and(eq(project.id, projectId), eq(project.accountId, accountId), isNull(project.deletedAt)),
      )
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'project not found');
  }

  async #row(accountId: string, id: string): Promise<SourceRow> {
    const rows = await this.#db.orm
      .select()
      .from(source)
      .where(and(eq(source.id, id), eq(source.accountId, accountId), isNull(source.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'source not found');
    return row;
  }
}

export function toSourceView(r: SourceRow): SourceView {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    mime: r.mime,
    size: r.size,
    status: r.status,
    chunkCount: r.chunkCount,
    error: r.error,
    indexedAt: r.indexedAt,
    createdAt: r.createdAt,
  };
}

/** Text, Markdown, CSV, JSON and code files (by type or extension). */
export function isTextSource(name: string, mime: string): boolean {
  const ext = extname(name).toLowerCase();
  return (
    TEXT_MIMES.has(mime) ||
    mime.startsWith('text/') ||
    (ATTACHMENT_LIMITS.textExtensions as readonly string[]).includes(ext)
  );
}

/**
 * Split text into chunks of about `size` characters that overlap by about `overlap`, breaking
 * on paragraph, then line, then word boundaries where possible.
 */
export function chunkText(
  input: string,
  size: number = SOURCE_LIMITS.chunkChars,
  overlap: number = SOURCE_LIMITS.overlapChars,
): string[] {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  if (text.length <= size) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) end = breakBefore(text, start + Math.floor(size / 2), end);
    const chunk = text.slice(start, end).trim();
    if (chunk) out.push(chunk);
    if (end >= text.length) break;
    start = breakAfter(text, Math.max(end - overlap, start + 1), end);
  }
  return out;
}

/** The best break position in [min, max]: after a paragraph, else a line, else a space. */
function breakBefore(text: string, min: number, max: number): number {
  const window = text.slice(min, max);
  for (const sep of ['\n\n', '\n', ' ']) {
    const i = window.lastIndexOf(sep);
    if (i >= 0) return min + i + sep.length;
  }
  return max;
}

/** The first boundary at or after `from` (and before `limit`), for the next chunk's start. */
function breakAfter(text: string, from: number, limit: number): number {
  const window = text.slice(from, limit);
  for (const sep of ['\n', ' ']) {
    const i = window.indexOf(sep);
    if (i >= 0) return from + i + 1;
  }
  return from;
}

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have how i if in is it ' +
    'its me my of on or our so that the their them then there these they this to was we were ' +
    'what when where which who why will with would you your about into than also just please ' +
    'tell show give'
  ).split(' '),
);

/**
 * A safe FTS5 query matching any meaningful term of the input: each term is a quoted phrase
 * joined by OR, so operators and punctuation in the input are plain text. Terms of four or more
 * characters match as prefixes ("refund" finds "refunds"), a cheap stand-in for stemming.
 */
export function orQuery(input: string): string | null {
  const seen = new Set<string>();
  for (const raw of input
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 32) break;
  }
  return seen.size
    ? [...seen].map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(' OR ')
    : null;
}

function cleanName(name: string): string {
  return (
    name
      .replace(/[\\/]/g, '_')
      .replace(/\p{Cc}/gu, '')
      .trim() || 'source'
  );
}

function decodeBase64(name: string, input: string): Buffer {
  let data = input;
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  if (comma >= 0) data = data.slice(comma + 1);
  data = data.replace(/\s+/g, '');
  if (data.length % 4 !== 0 || !BASE64.test(data)) {
    throw new NovaError(
      'validation',
      `"${name}" could not be read: the upload is not valid base64`,
      {
        details: { reason: 'encoding' },
      },
    );
  }
  return Buffer.from(data, 'base64');
}

function decodeUtf8(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
