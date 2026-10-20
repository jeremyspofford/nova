// Threads (FR-017): create, list, rename, pin, archive, soft-delete and search. Lists put pinned
// threads first, then most recently updated, and leave out side chats (FR-026). Search is FTS5
// over message text (docs/06 §4) ranked by bm25 and never returns temporary, side or deleted
// threads (FR-025, FR-027). M2 adds the message tree (FR-020): the detail is the active path,
// with versions, citations and queued input; branches inherit their parent's path (FR-033).
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type ArtifactKind,
  type CitationView,
  type CreateThreadRequest,
  type MentionKind,
  type MessageView,
  type Page,
  type PartView,
  type SearchHit,
  type ThreadDetail,
  type ThreadMode,
  type ThreadTree,
  type ThreadView,
  type ToolCallPartView,
  type UpdateThreadRequest,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import type { EventSink } from './events.ts';
import { queueViews } from './followups.ts';
import type { ModelRouter } from './routing/types.ts';
import { chainIds, newestDescendant, siblingGroups, visibleChain } from './tree.ts';

const { thread, message, messagePart, project, citation } = schema;

export type ThreadRow = typeof thread.$inferSelect;
type MessageRow = typeof message.$inferSelect;
type PartRow = typeof messagePart.$inferSelect;
type CitationRow = typeof citation.$inferSelect;

export interface ListThreadsOptions {
  mode?: ThreadMode | undefined;
  projectId?: string | undefined;
  archived?: boolean | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface SearchOptions {
  limit?: number | undefined;
  projectId?: string | undefined;
}

export interface ThreadServiceOptions {
  db: NovaDatabase;
  router: ModelRouter;
  /** The `chat.defaultModel` setting after precedence (docs/14 §1); null when unset. */
  defaultModel?: (accountId: string) => Promise<string | null>;
  /** Where branch and message-delete events go (optional for headless use). */
  events?: EventSink;
  now?: () => Date;
}

export class ThreadService {
  readonly #db: NovaDatabase;
  readonly #router: ModelRouter;
  readonly #defaultModel: (accountId: string) => Promise<string | null>;
  readonly #events: EventSink | undefined;
  readonly #now: () => Date;

  constructor(opts: ThreadServiceOptions) {
    this.#db = opts.db;
    this.#router = opts.router;
    this.#defaultModel = opts.defaultModel ?? (() => Promise.resolve(null));
    this.#events = opts.events;
    this.#now = opts.now ?? (() => new Date());
  }

  /** The default model for a new chat: the setting, else the first model of the first provider. */
  async defaultModel(accountId: string): Promise<string | null> {
    const setting = await this.#defaultModel(accountId);
    if (setting && (await this.#modelUsable(accountId, setting))) return setting;
    return this.#router.firstModel(accountId);
  }

  /** `opts.id`: a client-chosen id (a chat a sync replica created offline, FR-109). */
  async create(
    accountId: string,
    req: CreateThreadRequest,
    opts: { id?: string } = {},
  ): Promise<ThreadView> {
    if (req.projectId) await this.#assertProject(accountId, req.projectId);
    if (req.model !== undefined) await this.#assertModel(accountId, req.model);
    const model = req.model ?? (await this.defaultModel(accountId));
    const row = this.#newRow(accountId, {
      projectId: req.projectId ?? null,
      mode: req.mode ?? 'chat',
      title: cleanTitle(req.title),
      temporary: req.temporary ?? false,
      memoryOptOut: req.memoryOptOut ?? false,
      modelId: model,
      reasoningLevel: req.reasoningLevel ?? null,
      ...(opts.id ? { id: opts.id } : {}),
    });
    await this.#db.transaction(() => this.#db.orm.insert(thread).values(row));
    await this.#changed('thread.created', accountId, row.id);
    return toThreadView(row);
  }

  async list(accountId: string, opts: ListThreadsOptions = {}): Promise<Page<ThreadView>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: SQL[] = [
      eq(thread.accountId, accountId),
      isNull(thread.deletedAt),
      eq(thread.archived, opts.archived ?? false),
      eq(thread.side, false),
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

  /** The active path (oldest first), with versions, citations, provenance and the queue. */
  async detail(accountId: string, id: string): Promise<ThreadDetail> {
    const row = await this.row(accountId, id);
    const path = await this.activePath(row);
    return {
      thread: toThreadView(row),
      messages: this.#withAuthors(row, await this.messageViews(row.id, path)),
      queue: queueViews(this.#db, row.id),
    };
  }

  /**
   * In a thread shared with other people of the Hub (FR-217), who wrote each user message: the
   * writer recorded with it (`shared_message`), else the thread's owner; only their account id and
   * display name. A thread that is not shared gets nothing.
   */
  #withAuthors(row: ThreadRow, messages: MessageView[]): MessageView[] {
    const users = messages.filter((m) => m.role === 'user');
    if (!users.length) return messages;
    const shared = this.#db.raw
      .prepare('SELECT 1 FROM thread_share WHERE thread_id = ? LIMIT 1')
      .get(row.id);
    if (!shared) return messages;
    const marks = users.map(() => '?').join(', ');
    const by = new Map(
      (
        this.#db.raw
          .prepare(
            `SELECT message_id, account_id FROM shared_message WHERE message_id IN (${marks})`,
          )
          .all(...users.map((m) => m.id)) as { message_id: string; account_id: string }[]
      ).map((r) => [r.message_id, r.account_id]),
    );
    const names = new Map<string, string | null>();
    const nameOf = (id: string): string | null => {
      if (!names.has(id)) {
        const r = this.#db.raw.prepare('SELECT display_name FROM account WHERE id = ?').get(id) as
          { display_name: string | null } | undefined;
        names.set(id, r?.display_name ?? null);
      }
      return names.get(id) ?? null;
    };
    return messages.map((m) => {
      if (m.role !== 'user') return m;
      const accountId = by.get(m.id) ?? row.accountId;
      return { ...m, author: { accountId, displayName: nameOf(accountId) } };
    });
  }

  /** Visible messages on the thread's active path, oldest first. */
  activePath(row: ThreadRow): Promise<MessageRow[]> {
    return visibleChain(this.#db, row.activeLeafId, row.id);
  }

  /** Message views for `rows`; versions are listed only for the viewing thread's own messages. */
  async messageViews(viewThreadId: string, rows: MessageRow[]): Promise<MessageView[]> {
    if (!rows.length) return [];
    const ids = rows.map((m) => m.id);
    const parts = await this.#db.orm
      .select()
      .from(messagePart)
      .where(inArray(messagePart.messageId, ids))
      .orderBy(asc(messagePart.idx), asc(messagePart.id));
    const byMessage = new Map<string, PartRow[]>();
    for (const p of parts) {
      const list = byMessage.get(p.messageId) ?? [];
      list.push(p);
      byMessage.set(p.messageId, list);
    }
    const cites = await this.#db.orm
      .select()
      .from(citation)
      .where(inArray(citation.messageId, ids))
      .orderBy(asc(citation.idx), asc(citation.id));
    const citesBy = new Map<string, CitationRow[]>();
    for (const c of cites) {
      const list = citesBy.get(c.messageId) ?? [];
      list.push(c);
      citesBy.set(c.messageId, list);
    }
    const groups = siblingGroups(this.#db, viewThreadId);
    const synced = syncedFromDevice(this.#db, ids);
    return rows.map((m) => {
      const v = toMessageView(m, byMessage.get(m.id) ?? []);
      v.parentId = m.parentId;
      if (m.threadId === viewThreadId) {
        const sibs = groups.get(m.parentId ?? '');
        if (sibs && sibs.length > 1) v.siblingIds = sibs;
      }
      const cs = citesBy.get(m.id);
      if (cs?.length) v.citations = cs.map(toCitationView);
      if (m.role === 'user') {
        const label = synced.has(m.id) ? 'sync' : provenanceOf(m);
        if (label) v.provenance = label;
        const mentions = mentionsOf(byMessage.get(m.id) ?? []);
        if (mentions.length) v.mentions = mentions;
      } else if (m.authorKind === 'offline') v.provenance = 'offline';
      return v;
    });
  }

  async update(accountId: string, id: string, req: UpdateThreadRequest): Promise<ThreadView> {
    await this.row(accountId, id);
    if (req.model !== undefined) await this.#assertModel(accountId, req.model);
    if (req.projectId) await this.#assertProject(accountId, req.projectId);
    const set: Partial<ThreadRow> = {};
    if (req.title !== undefined) set.title = cleanTitle(req.title);
    if (req.pinned !== undefined) set.pinned = req.pinned;
    if (req.archived !== undefined) set.archived = req.archived;
    if (req.unread !== undefined) set.unread = req.unread;
    if (req.model !== undefined) set.modelId = req.model;
    if (req.reasoningLevel !== undefined) set.reasoningLevel = req.reasoningLevel;
    if (req.memoryOptOut !== undefined) set.memoryOptOut = req.memoryOptOut;
    if (req.projectId !== undefined) set.projectId = req.projectId;
    // Toggling flags is not activity; renaming or changing the model is.
    if (req.title !== undefined || req.model !== undefined || req.reasoningLevel !== undefined)
      set.updatedAt = this.#now().toISOString();
    if (Object.keys(set).length) {
      await this.#db.transaction(() =>
        this.#db.orm.update(thread).set(set).where(eq(thread.id, id)),
      );
      await this.#changed('thread.updated', accountId, id);
    }
    return this.view(accountId, id);
  }

  /**
   * Soft delete; its messages are marked too so nothing of it is searchable (docs/06 §6.5). Its
   * side chats go with it; branches are chats of their own and stay.
   */
  async remove(accountId: string, id: string): Promise<void> {
    await this.row(accountId, id);
    const now = this.#now().toISOString();
    const ids = [id, ...sideDescendants(this.#db, id)];
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(thread)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(thread.id, ids));
      await this.#db.orm
        .update(message)
        .set({ deletedAt: now })
        .where(and(inArray(message.threadId, ids), isNull(message.deletedAt)));
    });
    await this.#changed('thread.deleted', accountId, id);
  }

  /**
   * Create, update and delete have no other event; sync's change feed listens for these
   * (FR-109). Flag toggles do not move `updated_at`, so the event is the only trace of them. A
   * hint, not history: published, not persisted.
   */
  #changed(name: string, accountId: string, threadId: string): Promise<void> {
    this.#events?.emitEphemeral({
      name,
      actor: 'system',
      accountId,
      correlation: { threadId },
      payload: { threadId },
    });
    return Promise.resolve();
  }

  // ---- versions, branches, side chats (FR-020, FR-026, FR-033) ---------------------------

  /** Move the active path through `messageId`, continuing to its newest descendant. */
  async selectVersion(accountId: string, id: string, messageId: string): Promise<ThreadDetail> {
    await this.row(accountId, id);
    const m = await this.#ownMessage(id, messageId);
    const leaf = newestDescendant(this.#db, m.id, id);
    await this.#db.transaction(() =>
      this.#db.orm.update(thread).set({ activeLeafId: leaf }).where(eq(thread.id, id)),
    );
    return this.detail(accountId, id);
  }

  /**
   * Soft-delete a message of this thread and, for a user message, the reply to it in the same
   * turn. Deleted messages leave the detail, the model context and search. Returns their ids.
   */
  async deleteMessage(accountId: string, id: string, messageId: string): Promise<string[]> {
    const row = await this.row(accountId, id);
    const m = await this.#ownMessage(id, messageId);
    const ids = [m.id];
    if (m.role === 'user' && m.turnId) {
      const replies = await this.#db.orm
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.parentId, m.id),
            eq(message.turnId, m.turnId),
            eq(message.role, 'assistant'),
            isNull(message.deletedAt),
          ),
        );
      ids.push(...replies.map((r) => r.id));
    }
    const now = this.#now().toISOString();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(message)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(message.id, ids));
      // A deleted leaf hands the active path to its nearest live ancestor.
      if (row.activeLeafId && ids.includes(row.activeLeafId)) {
        const path = await visibleChain(this.#db, row.activeLeafId, id);
        await this.#db.orm
          .update(thread)
          .set({ activeLeafId: path.at(-1)?.id ?? null })
          .where(eq(thread.id, id));
      }
    });
    for (const mid of ids) {
      await this.#events?.emit({
        name: 'chat.message.deleted',
        actor: 'user',
        accountId,
        correlation: { threadId: id },
        payload: { threadId: id, messageId: mid },
      });
    }
    return ids;
  }

  /**
   * A new chat continuing from `fromMessageId` on this thread's active path. It inherits the
   * path up to and including that message by reference: no rows are copied (FR-020, FR-033).
   */
  async branch(
    accountId: string,
    id: string,
    req: { fromMessageId: string; title?: string | undefined },
  ): Promise<ThreadView> {
    const parent = await this.row(accountId, id);
    const path = await this.activePath(parent);
    if (!path.some((m) => m.id === req.fromMessageId))
      throw new NovaError('not_found', 'message not found on this chat');
    const title =
      cleanTitle(req.title) ?? (parent.title ? `Branch: ${parent.title}`.slice(0, 300) : 'Branch');
    const row = this.#newRow(accountId, {
      projectId: parent.projectId,
      mode: parent.mode,
      title,
      temporary: parent.temporary,
      memoryOptOut: parent.memoryOptOut,
      modelId: parent.modelId,
      reasoningLevel: parent.reasoningLevel,
      parentThreadId: parent.id,
      branchFromMessageId: req.fromMessageId,
      activeLeafId: req.fromMessageId,
    });
    await this.#db.transaction(() => this.#db.orm.insert(thread).values(row));
    await this.#events?.emit({
      name: 'chat.branch.created',
      actor: 'user',
      accountId,
      correlation: { threadId: row.id },
      payload: { threadId: row.id, parentId: parent.id, fromMessageId: req.fromMessageId },
    });
    return toThreadView(row);
  }

  /** A side chat of `parent` (FR-026): never listed, kept out of memory, temporary like it. */
  async createSide(accountId: string, parent: ThreadRow, model?: string): Promise<ThreadRow> {
    if (model !== undefined) await this.#assertModel(accountId, model);
    const row = this.#newRow(accountId, {
      projectId: parent.projectId,
      mode: parent.mode,
      title: null,
      temporary: parent.temporary,
      memoryOptOut: true,
      side: true,
      modelId: model ?? parent.modelId ?? (await this.defaultModel(accountId)),
      reasoningLevel: parent.reasoningLevel,
      parentThreadId: parent.id,
    });
    await this.#db.transaction(() => this.#db.orm.insert(thread).values(row));
    return row;
  }

  /** The lineage of a thread: its root plus every live descendant branch and side chat. */
  async tree(accountId: string, id: string): Promise<ThreadTree> {
    let root = await this.row(accountId, id);
    for (let i = 0; i < 1000 && root.parentThreadId; i++) {
      const up = await this.#db.orm
        .select()
        .from(thread)
        .where(
          and(
            eq(thread.id, root.parentThreadId),
            eq(thread.accountId, accountId),
            isNull(thread.deletedAt),
          ),
        )
        .limit(1);
      if (!up[0]) break;
      root = up[0];
    }
    const rows = this.#db.raw
      .prepare(
        `WITH RECURSIVE d(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT t.id, d.depth + 1 FROM thread t JOIN d ON t.parent_thread_id = d.id
           WHERE t.deleted_at IS NULL AND t.account_id = ? AND d.depth < 1000
         )
         SELECT t.id AS threadId, t.parent_thread_id AS parentThreadId,
                t.branch_from_message_id AS branchFromMessageId, t.title AS title, t.side AS side,
                t.created_at AS createdAt, t.updated_at AS updatedAt,
                (SELECT count(*) FROM message m WHERE m.thread_id = t.id AND m.deleted_at IS NULL)
                  AS messageCount
         FROM d JOIN thread t ON t.id = d.id
         ORDER BY d.depth, t.created_at, t.id`,
      )
      .all(root.id, accountId) as unknown as (Omit<ThreadTree['nodes'][number], 'side'> & {
      side: number;
    })[];
    return {
      rootThreadId: root.id,
      nodes: rows.map((r) => ({
        ...r,
        parentThreadId: r.threadId === root.id ? null : r.parentThreadId,
        side: r.side === 1,
      })),
    };
  }

  // ---- search ---------------------------------------------------------------------------

  /**
   * Full-text search over message text, best match first (bm25; newer breaks ties). Leaves out
   * temporary, side and deleted threads and deleted messages. Any input string is safe.
   */
  search(accountId: string, q: string, opts: SearchOptions | number = {}): SearchHit[] {
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100);
    const fts = ftsQuery(q);
    if (!fts) return [];
    const params: (string | number)[] = [fts, accountId];
    let projectFilter = '';
    if (o.projectId) {
      projectFilter = 'AND t.project_id = ?';
      params.push(o.projectId);
    }
    params.push(limit * 2);
    const rows = this.#db.raw
      .prepare(
        `SELECT m.thread_id AS threadId, m.id AS messageId, t.title AS threadTitle,
                snippet(message_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
                m.created_at AS createdAt, m.role AS role, t.project_id AS projectId
         FROM message_fts
         JOIN message_search s ON s.seq = message_fts.rowid
         JOIN message m ON m.id = s.message_id
         JOIN thread t ON t.id = m.thread_id
         WHERE message_fts MATCH ?
           AND t.account_id = ? AND t.deleted_at IS NULL AND t.temporary = 0 AND t.side = 0
           AND m.deleted_at IS NULL ${projectFilter}
         ORDER BY bm25(message_fts), m.created_at DESC, m.id DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as SearchHit[];
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

  // ---- helpers --------------------------------------------------------------------------

  /** True when `messageId` is on the chain of the thread's active leaf (deleted or not). */
  onActivePath(row: ThreadRow, messageId: string): boolean {
    return chainIds(this.#db, row.activeLeafId).has(messageId);
  }

  async #ownMessage(threadId: string, messageId: string): Promise<MessageRow> {
    const rows = await this.#db.orm
      .select()
      .from(message)
      .where(
        and(eq(message.id, messageId), eq(message.threadId, threadId), isNull(message.deletedAt)),
      )
      .limit(1);
    const m = rows[0];
    if (!m) throw new NovaError('not_found', 'message not found');
    return m;
  }

  #newRow(accountId: string, f: Partial<ThreadRow> & Pick<ThreadRow, 'mode'>): ThreadRow {
    const now = this.#now().toISOString();
    return {
      id: uuidv7(),
      accountId,
      projectId: null,
      title: null,
      parentThreadId: null,
      branchFromMessageId: null,
      temporary: false,
      side: false,
      memoryOptOut: false,
      modelId: null,
      reasoningLevel: null,
      pinned: false,
      archived: false,
      unread: false,
      state: 'idle',
      inputMode: 'steer',
      metadata: null,
      activeLeafId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...f,
    };
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

  #modelUsable(accountId: string, ref: string): Promise<boolean> {
    return this.#router.usable(accountId, ref);
  }
}

/** Side chats below a thread (recursively), which share its fate on delete. */
export function sideDescendants(db: NovaDatabase, id: string): string[] {
  return (
    db.raw
      .prepare(
        `WITH RECURSIVE d(id, depth) AS (
           SELECT id, 1 FROM thread WHERE parent_thread_id = ? AND side = 1
           UNION
           SELECT t.id, d.depth + 1 FROM thread t JOIN d ON t.parent_thread_id = d.id
           WHERE t.side = 1 AND d.depth < 1000
         )
         SELECT id FROM d`,
      )
      .all(id) as { id: string }[]
  ).map((r) => r.id);
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

interface PageCursor {
  pinned: number;
  updatedAt: string;
  id: string;
}

function encodeCursor(r: ThreadRow): string {
  return Buffer.from(JSON.stringify([r.pinned ? 1 : 0, r.updatedAt, r.id])).toString('base64url');
}

function decodeCursor(cursor: string): PageCursor {
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
      const e = parseJson(p.content) as {
        code?: unknown;
        message?: unknown;
        details?: { reason?: unknown; provider?: unknown } | null;
      } | null;
      const reason = e?.details?.reason;
      const provider = e?.details?.provider;
      return {
        type: 'error',
        code: typeof e?.code === 'string' ? e.code : 'provider_error',
        message: typeof e?.message === 'string' ? e.message : 'the response failed',
        // The structured marker (a spend cap's stop, FR-116), kept small.
        ...(typeof reason === 'string' && reason.length <= 40
          ? {
              details: {
                reason,
                ...(typeof provider === 'string' && provider.length <= 50 ? { provider } : {}),
              },
            }
          : {}),
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
    case 'tool_call':
      return toToolCallView(p);
    case 'artifact_ref': {
      const a = parseJson(p.content) as {
        artifactId?: unknown;
        kind?: unknown;
        title?: unknown;
      } | null;
      const id = typeof a?.artifactId === 'string' ? a.artifactId : p.refId;
      if (!id) return null;
      return {
        type: 'artifact',
        artifactId: id,
        kind: (typeof a?.kind === 'string' ? a.kind : 'file') as ArtifactKind,
        title: typeof a?.title === 'string' ? a.title : null,
      };
    }
    case 'compaction': {
      // A compaction item (FR-183): its summary and how much it stands for.
      const c = parseJson(p.content) as {
        trigger?: unknown;
        summary?: unknown;
        tokensBefore?: unknown;
        tokensAfter?: unknown;
        covered?: unknown;
        method?: unknown;
      } | null;
      if (typeof c?.summary !== 'string' || !c.summary) return null;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const trigger = ['pre_turn', 'mid_turn', 'post_turn', 'manual'].includes(String(c.trigger))
        ? (c.trigger as 'pre_turn' | 'mid_turn' | 'post_turn' | 'manual')
        : 'manual';
      return {
        type: 'compaction',
        trigger,
        summary: c.summary,
        tokensBefore: num(c.tokensBefore),
        tokensAfter: num(c.tokensAfter),
        covered: num(c.covered),
        method: c.method === 'model' ? 'model' : 'extractive',
      };
    }
    case 'notice': {
      const n = parseJson(p.content) as { code?: unknown; message?: unknown } | null;
      return typeof n?.message === 'string' && n.message
        ? {
            type: 'notice',
            code: typeof n.code === 'string' ? n.code : 'notice',
            message: n.message,
          }
        : null;
    }
    default:
      // tool_result and context parts feed the model only.
      return null;
  }
}

/**
 * How a user message entered its turn, as the thread labels it: typed, a steer or a queued send
 * (FR-019), a hook's continuation (FR-197), or M5's run objective, schedule fire, goal
 * continuation and sub-agent task (TurnStarter), or a message Nova itself started (`system`).
 */
/**
 * Messages a device appended through sync (FR-112, M7): the change feed records the device whose
 * op wrote each message body. Such a user message keeps author `user`, so the label comes from here.
 */
function syncedFromDevice(db: NovaDatabase, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.raw
      .prepare(
        `SELECT entity_id FROM sync_field WHERE kind = 'message' AND field = 'body'
         AND device_id IS NOT NULL AND entity_id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as { entity_id: string }[];
    for (const r of rows) out.add(r.entity_id);
  }
  return out;
}

function provenanceOf(m: MessageRow): MessageView['provenance'] | null {
  switch (m.authorKind) {
    case 'hook':
    case 'run':
    case 'schedule':
    case 'goal':
    case 'subagent':
    case 'system':
      return m.authorKind;
    default:
      return m.delivery ?? 'typed';
  }
}

/**
 * The `@`-mentions sent with a user message, from its `context` parts (FR-022). A skill loaded
 * by a `/name` (FR-046) and hook context (FR-197) are context too, but not mentions.
 */
function mentionsOf(parts: PartRow[]): NonNullable<MessageView['mentions']> {
  return parts.flatMap((p) => {
    if (p.type !== 'context') return [];
    const c = parseJson(p.content) as {
      kind?: unknown;
      mention?: unknown;
      ref?: unknown;
      label?: unknown;
      via?: unknown;
    } | null;
    if (c?.kind !== 'mention' || typeof c.ref !== 'string' || typeof c.mention !== 'string')
      return [];
    if (c.via === 'slash') return [];
    return [
      {
        kind: c.mention as MentionKind,
        ref: c.ref,
        label: typeof c.label === 'string' ? c.label : c.ref,
      },
    ];
  });
}

/** A stored tool call card (M3, FR-099): the runtime keeps the part's JSON current. */
function toToolCallView(p: PartRow): ToolCallPartView | null {
  const v = parseJson(p.content) as Partial<ToolCallPartView> | null;
  if (!v) return null;
  const s = (x: unknown) => (typeof x === 'string' ? x : null);
  return {
    type: 'tool_call',
    callId: s(v.callId) ?? p.refId ?? p.id,
    tool: s(v.tool) ?? 'unknown',
    title: s(v.title),
    source: (s(v.source) ?? 'builtin') as ToolCallPartView['source'],
    status: (s(v.status) ?? 'error') as ToolCallPartView['status'],
    argsPreview: s(v.argsPreview) ?? '',
    resultPreview: s(v.resultPreview),
    error: s(v.error),
    approvalId: s(v.approvalId),
    durationMs: typeof v.durationMs === 'number' ? v.durationMs : null,
  };
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

export function toCitationView(c: CitationRow): CitationView {
  return {
    id: c.id,
    messageId: c.messageId,
    idx: c.idx ?? 0,
    url: c.url,
    sourceId: c.sourceId,
    title: c.title,
    snippet: c.snippet,
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
