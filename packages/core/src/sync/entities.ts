// What sync replicates and how its current state is read (FR-109, docs/13 §2.1 as built). Each
// kind reads its rows straight from the Hub's tables (synchronously, so a read and the change it
// records share one transaction) and describes which fields replicas may write and how pushed
// values are checked. A row that is gone, soft-deleted or no longer synced reads as null and
// becomes a tombstone.
import { z } from 'zod';
import {
  MAX_PAGE_CHARS,
  SETTINGS,
  SYNC_FIELDS,
  SYNC_TOMBSTONE,
  isSettingKey,
  syncMessageBodySchema,
  type SyncKind,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';

/** One entity as sync sees it: its account, its parent (a message's thread) and its fields. */
export interface SyncEntity {
  kind: SyncKind;
  id: string;
  accountId: string;
  parentId: string | null;
  fields: Record<string, unknown>;
  /**
   * When the row was last written (Unix ms; 0 for a setting at its default): the clock a field
   * gets when the feed first sees it, so a value older than a device's edit does not look newer
   * just because the Hub noticed it late.
   */
  writtenAt: number | null;
}

export interface SyncReader {
  kind: SyncKind;
  /** The entity as it is now, or null when it is gone or not synced. */
  read(id: string): SyncEntity | null;
  /** Live entities in id order after `after` (the full sweep). */
  page(after: string, limit: number): SyncEntity[];
}

/** Pushed values per writable field (the services check again when they apply them). */
export const SYNC_FIELD_SCHEMAS: Record<SyncKind, Record<string, z.ZodType>> = {
  thread: {
    title: z.string().max(300).nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    project: z.string().min(1).max(100).nullable(),
  },
  message: { body: syncMessageBodySchema },
  project: {
    name: z.string().trim().min(1).max(200),
    instructions: z.string().max(20_000).nullable(),
  },
  memory: {
    content: z.string().trim().min(1).max(2_000),
    status: z.enum(['active', 'dismissed']),
  },
  space: { name: z.string().trim().min(1).max(200) },
  page: {
    title: z.string().trim().min(1).max(200),
    content: z.string().max(MAX_PAGE_CHARS),
  },
  schedule: { enabled: z.boolean() },
  // Checked against the setting's own schema by the settings writer.
  setting: { value: z.unknown() },
};

export const tombstoneSchema = z.literal(true);

/** Writable fields of a kind. */
export function writableFields(kind: SyncKind): readonly string[] {
  return SYNC_FIELDS[kind].write;
}

/** Every field a kind replicates (written and read-only). */
export function knownField(kind: SyncKind, field: string): boolean {
  if (field === SYNC_TOMBSTONE) return true;
  const f = SYNC_FIELDS[kind] as { write: readonly string[]; read: readonly string[] };
  return f.write.includes(field) || f.read.includes(field);
}

/** A global setting replicas see: a known key that is not security-relevant (docs/14 §1). */
export function syncableSetting(key: string): boolean {
  return isSettingKey(key) && !(SETTINGS[key] as { security?: boolean }).security;
}

function json(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '';
const msOf = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The readers for every kind. `owner` is the account that holds the Hub's global settings. */
export function syncReaders(
  db: NovaDatabase,
  owner: () => string | null,
): Record<SyncKind, SyncReader> {
  const get = (sql: string, ...args: (string | number)[]) =>
    db.raw.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: (string | number)[]) =>
    db.raw.prepare(sql).all(...args) as Row[];

  // ---- threads: the account's chats, not temporary and not side chats ----------------------
  const THREAD = `SELECT id, account_id, title, pinned, archived, project_id, mode, created_at,
      updated_at
    FROM thread WHERE deleted_at IS NULL AND temporary = 0 AND side = 0`;
  const thread = (r: Row): SyncEntity => ({
    kind: 'thread',
    id: str(r.id),
    accountId: str(r.account_id),
    parentId: null,
    fields: {
      title: strOrNull(r.title),
      pinned: r.pinned === 1,
      archived: r.archived === 1,
      project: strOrNull(r.project_id),
      mode: str(r.mode),
      createdAt: str(r.created_at),
    },
    writtenAt: msOf(r.updated_at),
  });

  // ---- messages: finished user and assistant messages of synced threads ---------------------
  const MESSAGE = `SELECT m.id, m.thread_id, m.role, m.author_kind, m.status, m.parent_id,
      m.model_id, m.created_at, m.updated_at, t.account_id
    FROM message m JOIN thread t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL AND m.role IN ('user', 'assistant') AND m.status <> 'streaming'
      AND t.deleted_at IS NULL AND t.temporary = 0 AND t.side = 0`;
  const message = (r: Row): SyncEntity => {
    const parts = all(
      'SELECT type, content, ref_id, mime FROM message_part WHERE message_id = ? ORDER BY idx, id',
      str(r.id),
    );
    const text: string[] = [];
    const files: { attachmentId: string; name: string; mime: string | null; size: number }[] = [];
    for (const p of parts) {
      if (p.type === 'text' && typeof p.content === 'string' && p.content) text.push(p.content);
      if (p.type === 'file') {
        const f = json(strOrNull(p.content)) as {
          attachmentId?: unknown;
          name?: unknown;
          size?: unknown;
        } | null;
        files.push({
          attachmentId: typeof f?.attachmentId === 'string' ? f.attachmentId : str(p.ref_id),
          name: typeof f?.name === 'string' ? f.name : 'file',
          mime: strOrNull(p.mime),
          size: typeof f?.size === 'number' ? f.size : 0,
        });
      }
    }
    return {
      kind: 'message',
      id: str(r.id),
      accountId: str(r.account_id),
      parentId: str(r.thread_id),
      fields: {
        // Attachments travel as metadata only: blobs are never synced (docs/13 §2.1).
        body: {
          threadId: str(r.thread_id),
          role: str(r.role),
          text: text.join('\n\n'),
          parentId: strOrNull(r.parent_id),
          status: str(r.status),
          model: strOrNull(r.model_id),
          // An answer a device's local model wrote (FR-128).
          provenance: r.author_kind === 'offline' ? 'offline' : null,
          files,
          createdAt: str(r.created_at),
        },
      },
      writtenAt: msOf(r.updated_at),
    };
  };

  // ---- projects -----------------------------------------------------------------------------
  const PROJECT = `SELECT id, account_id, name, instructions, created_at, updated_at FROM project
    WHERE deleted_at IS NULL`;
  const project = (r: Row): SyncEntity => ({
    kind: 'project',
    id: str(r.id),
    accountId: str(r.account_id),
    parentId: null,
    fields: {
      name: str(r.name),
      instructions: strOrNull(r.instructions),
      createdAt: str(r.created_at),
    },
    writtenAt: msOf(r.updated_at),
  });

  // ---- memory items: the account's global and project memory (agents keep their own) --------
  const MEMORY = `SELECT id, account_id, content, status, scope_kind, scope_ref, category, created_at,
      updated_at
    FROM memory_item WHERE scope_kind IN ('global', 'project') AND revoked_at IS NULL`;
  const memory = (r: Row): SyncEntity => ({
    kind: 'memory',
    id: str(r.id),
    accountId: str(r.account_id),
    parentId: null,
    fields: {
      content: str(r.content),
      status: str(r.status),
      scope: { kind: str(r.scope_kind), ref: strOrNull(r.scope_ref) },
      category: strOrNull(r.category),
      createdAt: str(r.created_at),
    },
    writtenAt: msOf(r.updated_at),
  });

  // ---- spaces: the names replicas show their pages under -----------------------------------
  const SPACE = `SELECT id, account_id, name, created_at, updated_at FROM space
    WHERE deleted_at IS NULL`;
  const space = (r: Row): SyncEntity => ({
    kind: 'space',
    id: str(r.id),
    accountId: str(r.account_id),
    parentId: null,
    fields: { name: str(r.name), createdAt: str(r.created_at) },
    writtenAt: msOf(r.updated_at),
  });

  // ---- pages of live spaces (the notes of docs/18 J9) ---------------------------------------
  const PAGE = `SELECT p.id, p.account_id, p.space_id, p.title, p.content, p.version, p.created_at,
      p.updated_at
    FROM space_page p JOIN space s ON s.id = p.space_id
    WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL`;
  const page = (r: Row): SyncEntity => ({
    kind: 'page',
    id: str(r.id),
    accountId: str(r.account_id),
    parentId: null,
    fields: {
      title: str(r.title),
      content: str(r.content),
      space: str(r.space_id),
      // Read-only: the page's history counts its own versions (FR-036).
      version: typeof r.version === 'number' ? r.version : Number(r.version ?? 0),
      createdAt: str(r.created_at),
    },
    writtenAt: msOf(r.updated_at),
  });

  // ---- schedules (an agent's self-set wakes are transient and stay on the Hub) --------------
  const SCHEDULE = `SELECT id, account_id, title, enabled, updated_at FROM schedule
    WHERE origin <> 'agent_self'`;
  const schedule = (r: Row): SyncEntity => ({
    kind: 'schedule',
    id: str(r.id),
    accountId: str(r.account_id),
    parentId: null,
    fields: { title: str(r.title), enabled: r.enabled === 1 },
    writtenAt: msOf(r.updated_at),
  });

  // ---- global settings that are not security-relevant, held by the owner's account ----------
  const setting = (key: string, row: Row | undefined): SyncEntity | null => {
    const accountId = owner();
    if (!accountId || !isSettingKey(key) || !syncableSetting(key)) return null;
    // A key without a stored value reads as its default: a reset is a change, not a delete.
    const value = row ? json(str(row.value_json)) : SETTINGS[key].default;
    return {
      kind: 'setting',
      id: key,
      accountId,
      parentId: null,
      fields: { value },
      writtenAt: row ? msOf(row.updated_at) : 0,
    };
  };

  const byId = (base: string, alias: string, map: (r: Row) => SyncEntity): SyncReader['read'] => {
    const sql = `${base} AND ${alias}id = ?`;
    return (id) => {
      const r = get(sql, id);
      return r ? map(r) : null;
    };
  };
  const paged = (base: string, alias: string, map: (r: Row) => SyncEntity): SyncReader['page'] => {
    const sql = `${base} AND ${alias}id > ? ORDER BY ${alias}id LIMIT ?`;
    return (after, limit) => all(sql, after, limit).map(map);
  };

  return {
    thread: { kind: 'thread', read: byId(THREAD, '', thread), page: paged(THREAD, '', thread) },
    message: {
      kind: 'message',
      read: byId(MESSAGE, 'm.', message),
      page: paged(MESSAGE, 'm.', message),
    },
    project: {
      kind: 'project',
      read: byId(PROJECT, '', project),
      page: paged(PROJECT, '', project),
    },
    memory: { kind: 'memory', read: byId(MEMORY, '', memory), page: paged(MEMORY, '', memory) },
    space: { kind: 'space', read: byId(SPACE, '', space), page: paged(SPACE, '', space) },
    page: { kind: 'page', read: byId(PAGE, 'p.', page), page: paged(PAGE, 'p.', page) },
    schedule: {
      kind: 'schedule',
      read: byId(SCHEDULE, '', schedule),
      page: paged(SCHEDULE, '', schedule),
    },
    setting: {
      kind: 'setting',
      read: (key) => {
        const r = get(
          "SELECT value_json, updated_at FROM setting WHERE key = ? AND scope_kind = 'global' AND scope_ref = ''",
          key,
        );
        return setting(key, r);
      },
      page: (after, limit) =>
        all(
          `SELECT key, value_json, updated_at FROM setting WHERE scope_kind = 'global'
           AND scope_ref = '' AND key > ? ORDER BY key LIMIT ?`,
          after,
          limit,
        ).flatMap((r) => {
          const e = setting(str(r.key), r);
          return e ? [e] : [];
        }),
    },
  };
}

/**
 * Messages changed after a watermark (`updated_at`, then id), oldest first: the sweep reads
 * messages this way instead of all of them, because only new and finished ones change.
 */
export function messagesChangedAfter(
  db: NovaDatabase,
  after: { updatedAt: string; id: string },
  limit: number,
): { id: string; updatedAt: string }[] {
  return (
    db.raw
      .prepare(
        `SELECT id, updated_at FROM message
         WHERE updated_at > ? OR (updated_at = ? AND id > ?)
         ORDER BY updated_at, id LIMIT ?`,
      )
      .all(after.updatedAt, after.updatedAt, after.id, limit) as {
      id: string;
      updated_at: string;
    }[]
  ).map((r) => ({ id: r.id, updatedAt: r.updated_at }));
}
