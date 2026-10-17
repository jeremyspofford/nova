// Threads (FR-017): create, list, rename, pin, archive, soft-delete and search. Lists put pinned
// threads first, then most recently updated; search is FTS5 over message text (docs/06 §4) and
// never returns temporary or deleted threads (FR-027).
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  NovaError,
  parseModelRef,
  uuidv7,
  type CreateThreadRequest,
  type MessageView,
  type Page,
  type PartView,
  type SearchHit,
  type ThreadDetail,
  type ThreadMode,
  type ThreadView,
  type UpdateThreadRequest,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import type { ProviderRegistry } from './registry.ts';

const { thread, message, messagePart, project } = schema;

export type ThreadRow = typeof thread.$inferSelect;
type MessageRow = typeof message.$inferSelect;
type PartRow = typeof messagePart.$inferSelect;

export interface ListThreadsOptions {
  mode?: ThreadMode | undefined;
  projectId?: string | undefined;
  archived?: boolean | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ThreadServiceOptions {
  db: NovaDatabase;
  registry: ProviderRegistry;
  /** The `chat.defaultModel` setting after precedence (docs/14 §1); null when unset. */
  defaultModel?: (accountId: string) => Promise<string | null>;
  now?: () => Date;
}

export class ThreadService {
  readonly #db: NovaDatabase;
  readonly #registry: ProviderRegistry;
  readonly #defaultModel: (accountId: string) => Promise<string | null>;
  readonly #now: () => Date;

  constructor(opts: ThreadServiceOptions) {
    this.#db = opts.db;
    this.#registry = opts.registry;
    this.#defaultModel = opts.defaultModel ?? (() => Promise.resolve(null));
    this.#now = opts.now ?? (() => new Date());
  }

  /** The default model for a new chat: the setting, else the first model of the first provider. */
  async defaultModel(accountId: string): Promise<string | null> {
    const setting = await this.#defaultModel(accountId);
    if (setting && (await this.#modelUsable(accountId, setting))) return setting;
    return this.#registry.firstModel(accountId);
  }

  async create(accountId: string, req: CreateThreadRequest): Promise<ThreadView> {
    if (req.projectId) await this.#assertProject(accountId, req.projectId);
    if (req.model !== undefined) await this.#assertModel(accountId, req.model);
    const model = req.model ?? (await this.defaultModel(accountId));
    const now = this.#now().toISOString();
    const row: ThreadRow = {
      id: uuidv7(),
      accountId,
      projectId: req.projectId ?? null,
      mode: req.mode ?? 'chat',
      title: cleanTitle(req.title),
      parentThreadId: null,
      branchFromMessageId: null,
      temporary: req.temporary ?? false,
      side: false,
      memoryOptOut: req.memoryOptOut ?? false,
      modelId: model,
      reasoningLevel: req.reasoningLevel ?? null,
      pinned: false,
      archived: false,
      unread: false,
      state: 'idle',
      inputMode: 'steer',
      metadata: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.#db.transaction(() => this.#db.orm.insert(thread).values(row));
    return toThreadView(row);
  }

  async list(accountId: string, opts: ListThreadsOptions = {}): Promise<Page<ThreadView>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: SQL[] = [
      eq(thread.accountId, accountId),
      isNull(thread.deletedAt),
      eq(thread.archived, opts.archived ?? false),
    ];
    if (opts.mode) where.push(eq(thread.mode, opts.mode));
    if (opts.projectId) where.push(eq(thread.projectId, opts.projectId));
    const q = opts.q?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const fts = ftsQuery(q);
      where.push(
        fts
          ? sql`(${thread.title} LIKE ${like} ESCAPE '\\' OR ${thread.id} IN (
              SELECT m.thread_id FROM message_fts
              JOIN message_search s ON s.seq = message_fts.rowid
              JOIN message m ON m.id = s.message_id
              WHERE message_fts MATCH ${fts} AND m.deleted_at IS NULL))`
          : sql`${thread.title} LIKE ${like} ESCAPE '\\'`,
      );
    }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      where.push(
        sql`(${thread.pinned} < ${c.pinned}
          OR (${thread.pinned} = ${c.pinned} AND ${thread.updatedAt} < ${c.updatedAt})
          OR (${thread.pinned} = ${c.pinned} AND ${thread.updatedAt} = ${c.updatedAt} AND ${thread.id} < ${c.id}))`,
      );
    }
    const rows = await this.#db.orm
      .select()
      .from(thread)
      .where(and(...where))
      .orderBy(desc(thread.pinned), desc(thread.updatedAt), desc(thread.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(toThreadView),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /** The live (not deleted) row, scoped to the account; `not_found` otherwise. */
  async row(accountId: string, id: string): Promise<ThreadRow> {
    const rows = await this.#db.orm
      .select()
      .from(thread)
      .where(and(eq(thread.id, id), eq(thread.accountId, accountId), isNull(thread.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'thread not found');
    return row;
  }

  async view(accountId: string, id: string): Promise<ThreadView> {
    return toThreadView(await this.row(accountId, id));
  }

  async detail(accountId: string, id: string): Promise<ThreadDetail> {
    const row = await this.row(accountId, id);
    const messages = await this.#db.orm
      .select()
      .from(message)
      .where(and(eq(message.threadId, id), isNull(message.deletedAt)))
      .orderBy(asc(message.createdAt), asc(message.id));
    const parts = messages.length
      ? await this.#db.orm
          .select()
          .from(messagePart)
          .where(
            inArray(
              messagePart.messageId,
              messages.map((m) => m.id),
            ),
          )
          .orderBy(asc(messagePart.idx), asc(messagePart.id))
      : [];
    const byMessage = new Map<string, PartRow[]>();
    for (const p of parts) {
      const list = byMessage.get(p.messageId) ?? [];
      list.push(p);
      byMessage.set(p.messageId, list);
    }
    return {
      thread: toThreadView(row),
      messages: messages.map((m) => toMessageView(m, byMessage.get(m.id) ?? [])),
    };
  }

  async update(accountId: string, id: string, req: UpdateThreadRequest): Promise<ThreadView> {
    await this.row(accountId, id);
    if (req.model !== undefined) await this.#assertModel(accountId, req.model);
    const set: Partial<ThreadRow> = {};
    if (req.title !== undefined) set.title = cleanTitle(req.title);
    if (req.pinned !== undefined) set.pinned = req.pinned;
    if (req.archived !== undefined) set.archived = req.archived;
    if (req.unread !== undefined) set.unread = req.unread;
    if (req.model !== undefined) set.modelId = req.model;
    if (req.reasoningLevel !== undefined) set.reasoningLevel = req.reasoningLevel;
    // Toggling flags is not activity; renaming or changing the model is.
    if (req.title !== undefined || req.model !== undefined || req.reasoningLevel !== undefined)
      set.updatedAt = this.#now().toISOString();
    if (Object.keys(set).length) {
      await this.#db.transaction(() =>
        this.#db.orm.update(thread).set(set).where(eq(thread.id, id)),
      );
    }
    return this.view(accountId, id);
  }

  /** Soft delete; its messages are marked too so nothing of it is searchable (docs/06 §6.5). */
  async remove(accountId: string, id: string): Promise<void> {
    await this.row(accountId, id);
    const now = this.#now().toISOString();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(thread)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(thread.id, id));
      await this.#db.orm
        .update(message)
        .set({ deletedAt: now })
        .where(and(eq(message.threadId, id), isNull(message.deletedAt)));
    });
  }

  /** Full-text search over message text, newest first. Any input string is safe. */
  search(accountId: string, q: string, limit = 20): SearchHit[] {
    const fts = ftsQuery(q);
    if (!fts) return [];
    const rows = this.#db.raw
      .prepare(
        `SELECT m.thread_id AS threadId, m.id AS messageId, t.title AS threadTitle,
                snippet(message_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet, m.created_at AS createdAt
         FROM message_fts
         JOIN message_search s ON s.seq = message_fts.rowid
         JOIN message m ON m.id = s.message_id
         JOIN thread t ON t.id = m.thread_id
         WHERE message_fts MATCH ?
           AND t.account_id = ? AND t.deleted_at IS NULL AND t.temporary = 0
           AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
      )
      .all(fts, accountId, Math.min(Math.max(limit, 1), 100) * 2) as unknown as SearchHit[];
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.messageId)) continue;
      seen.add(r.messageId);
      out.push({ ...r });
      if (out.length >= limit) break;
    }
    return out;
  }

  async #assertProject(accountId: string, projectId: string): Promise<void> {
    const rows = await this.#db.orm
      .select({ id: project.id })
      .from(project)
      .where(
        and(eq(project.id, projectId), eq(project.accountId, accountId), isNull(project.deletedAt)),
      )
      .limit(1);
    if (!rows[0])
      throw new NovaError('validation', 'project not found', { details: { reason: 'project' } });
  }

  async #assertModel(accountId: string, ref: string): Promise<void> {
    if (!(await this.#modelUsable(accountId, ref))) {
      throw new NovaError('validation', `unknown model: ${ref}`, {
        details: { reason: 'unknown_model', model: ref },
      });
    }
  }

  async #modelUsable(accountId: string, ref: string): Promise<boolean> {
    const parsed = parseModelRef(ref);
    if (!parsed) return false;
    try {
      await this.#registry.account(accountId, parsed.providerAccountId);
      return true;
    } catch {
      return false;
    }
  }
}

// ---- search query -----------------------------------------------------------------------

/**
 * Turn user input into a safe FTS5 query: every whitespace-separated token becomes a quoted
 * prefix phrase (`"tok"*`), so operators, quotes, parentheses and column filters in the input
 * are plain text. Returns null when nothing searchable remains.
 */
export function ftsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFKC')
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return tokens.length ? tokens.join(' ') : null;
}

// ---- cursors ----------------------------------------------------------------------------

interface Cursor {
  pinned: number;
  updatedAt: string;
  id: string;
}

function encodeCursor(r: ThreadRow): string {
  return Buffer.from(JSON.stringify([r.pinned ? 1 : 0, r.updatedAt, r.id])).toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const v = Array.isArray(parsed) ? (parsed as unknown[]) : null;
    if (
      v &&
      v.length === 3 &&
      (v[0] === 0 || v[0] === 1) &&
      typeof v[1] === 'string' &&
      typeof v[2] === 'string'
    ) {
      return { pinned: v[0], updatedAt: v[1], id: v[2] };
    }
  } catch {
    // fall through
  }
  throw new NovaError('validation', 'invalid cursor', { details: { reason: 'cursor' } });
}

// ---- views ------------------------------------------------------------------------------

function cleanTitle(title: string | null | undefined): string | null {
  if (title === undefined || title === null) return null;
  const t = title.replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

/** First 60 characters of the first user message, as a title (no model call in M1). */
export function titleFrom(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 60).trimEnd() : null;
}

export function toThreadView(r: ThreadRow): ThreadView {
  return {
    id: r.id,
    mode: r.mode,
    title: r.title,
    projectId: r.projectId,
    pinned: r.pinned,
    archived: r.archived,
    unread: r.unread,
    temporary: r.temporary,
    state: r.state,
    model: r.modelId,
    reasoningLevel: r.reasoningLevel,
    parentThreadId: r.parentThreadId,
    branchFromMessageId: r.branchFromMessageId,
    side: r.side,
    memoryOptOut: r.memoryOptOut,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toPartView(p: PartRow): PartView | null {
  switch (p.type) {
    case 'text':
    case 'reasoning':
      return p.content ? { type: p.type, text: p.content } : null;
    case 'error': {
      const e = parseJson(p.content) as { code?: unknown; message?: unknown } | null;
      return {
        type: 'error',
        code: typeof e?.code === 'string' ? e.code : 'provider_error',
        message: typeof e?.message === 'string' ? e.message : 'the response failed',
      };
    }
    case 'file': {
      const f = parseJson(p.content) as {
        attachmentId?: unknown;
        name?: unknown;
        size?: unknown;
      } | null;
      return {
        type: 'file',
        attachmentId: typeof f?.attachmentId === 'string' ? f.attachmentId : (p.refId ?? ''),
        name: typeof f?.name === 'string' ? f.name : 'file',
        mime: p.mime ?? 'application/octet-stream',
        size: typeof f?.size === 'number' ? f.size : 0,
      };
    }
    default:
      return null;
  }
}

export function toMessageView(m: MessageRow, parts: PartRow[]): MessageView {
  const usage = parseJson(m.usageJson) as {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  } | null;
  return {
    id: m.id,
    threadId: m.threadId,
    turnId: m.turnId,
    role: m.role,
    status: m.status,
    parts: parts.flatMap((p) => {
      const v = toPartView(p);
      return v ? [v] : [];
    }),
    model: m.modelId,
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          costUsd: usage.costUsd ?? 0,
        }
      : null,
    createdAt: m.createdAt,
  };
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
