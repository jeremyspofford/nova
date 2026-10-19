// How a pushed or restored value reaches the Hub's own data (FR-109): through the same services the
// API uses, so their checks, history (page versions), events and side effects (schedules re-arm,
// memory summaries go stale) apply to sync exactly as to any other write. The one write no service
// offers is appending a user message without starting a turn: a replica's offline message is
// recorded as written, and the user decides on the Hub whether to send it on (FR-112).
import { NovaError, uuidv7, type SyncKind, type SyncMessageBody } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { EventSink } from '../events.ts';
import type { MemoryService } from '../memory.ts';
import type { ProjectService } from '../projects.ts';
import type { ScheduleService } from '../scheduler/service.ts';
import type { SpaceService } from '../spaces/service.ts';
import type { ThreadService } from '../threads.ts';

/** Who and when, for writes that record it. */
export interface SyncWriteContext {
  /** The device whose op this is; null for a restore from a non-device session. */
  deviceId: string | null;
  /** The op's physical time (Unix ms) as the device claims it; never recorded as fact. */
  atMs: number;
  /** When the Hub received the write (Unix ms): the time it records. */
  receivedMs: number;
}

export interface SyncWriter {
  /** Create an entity with a client-chosen id (kinds in SYNC_CREATABLE). */
  create?(
    accountId: string,
    id: string,
    fields: Record<string, unknown>,
    ctx: SyncWriteContext,
  ): Promise<void>;
  update(
    accountId: string,
    id: string,
    fields: Record<string, unknown>,
    ctx: SyncWriteContext,
  ): Promise<void>;
  remove?(accountId: string, id: string, ctx: SyncWriteContext): Promise<void>;
}

export type SyncWriters = Partial<Record<SyncKind, SyncWriter>>;

/** The services the writers use; a missing one makes its kind read-only for replicas. */
export interface SyncWriterServices {
  db: NovaDatabase;
  events?: EventSink | undefined;
  threads?: Pick<ThreadService, 'create' | 'update' | 'remove'> | undefined;
  projects?: Pick<ProjectService, 'update' | 'remove'> | undefined;
  memory?: Pick<MemoryService, 'update' | 'remove'> | undefined;
  spaces?: Pick<SpaceService, 'savePage' | 'deletePage' | 'updateSpace'> | undefined;
  schedules?: Pick<ScheduleService, 'update'> | undefined;
  /** Validate and store one global setting (the Hub's settings writer, docs/14 §1). */
  setting?: ((accountId: string, key: string, value: unknown) => Promise<void>) | undefined;
}

const has = (fields: Record<string, unknown>, k: string) => Object.hasOwn(fields, k);

export function serviceWriters(s: SyncWriterServices): SyncWriters {
  const out: SyncWriters = {
    message: { create: (a, id, f, ctx) => appendMessage(s, a, id, f, ctx), update: appendOnly },
  };
  const threads = s.threads;
  if (threads) {
    const patch = (f: Record<string, unknown>) => ({
      ...(has(f, 'title') ? { title: f.title as string | null } : {}),
      ...(has(f, 'pinned') ? { pinned: f.pinned as boolean } : {}),
      ...(has(f, 'archived') ? { archived: f.archived as boolean } : {}),
      ...(has(f, 'project') ? { projectId: f.project as string | null } : {}),
    });
    out.thread = {
      create: async (accountId, id, f) => {
        await threads.create(
          accountId,
          {
            ...(typeof f.title === 'string' ? { title: f.title } : {}),
            ...(typeof f.project === 'string' ? { projectId: f.project } : {}),
          },
          { id },
        );
        const rest = patch(f);
        delete rest.title;
        delete rest.projectId;
        if (Object.keys(rest).length) await threads.update(accountId, id, rest);
      },
      update: async (accountId, id, f) => {
        const p = patch(f);
        if (Object.keys(p).length) await threads.update(accountId, id, p);
      },
      remove: (accountId, id) => threads.remove(accountId, id),
    };
  }
  const projects = s.projects;
  if (projects) {
    out.project = {
      update: async (accountId, id, f) => {
        await projects.update(accountId, id, {
          ...(has(f, 'name') ? { name: f.name as string } : {}),
          ...(has(f, 'instructions') ? { instructions: f.instructions as string | null } : {}),
        });
      },
      remove: (accountId, id) => projects.remove(accountId, id),
    };
  }
  const memory = s.memory;
  if (memory) {
    out.memory = {
      update: async (accountId, id, f) => {
        await memory.update(accountId, id, {
          ...(has(f, 'content') ? { content: f.content as string } : {}),
          ...(has(f, 'status') ? { status: f.status as 'active' | 'dismissed' } : {}),
        });
      },
      remove: (accountId, id) => memory.remove(accountId, id),
    };
  }
  const spaces = s.spaces;
  if (spaces) {
    const current = (id: string) =>
      s.db.raw.prepare('SELECT space_id, version FROM space_page WHERE id = ?').get(id) as
        { space_id: string; version: number } | undefined;
    out.page = {
      // Last writer wins: the save is based on whatever version is current now; the version it
      // replaces stays in the page's history (FR-036) and the value in the merge log.
      update: async (accountId, id, f) => {
        const cur = current(id);
        if (!cur) throw new NovaError('not_found', 'page not found');
        await spaces.savePage(accountId, null, id, {
          baseVersion: cur.version,
          ...(has(f, 'title') ? { title: f.title as string } : {}),
          ...(has(f, 'content') ? { content: f.content as string } : {}),
          summary: 'Synced from a device',
        });
      },
      remove: async (accountId, id) => {
        const cur = current(id);
        if (!cur) throw new NovaError('not_found', 'page not found');
        await spaces.deletePage(accountId, cur.space_id, id);
      },
    };
  }
  if (spaces) {
    out.space = {
      update: async (accountId, id, f) => {
        if (has(f, 'name')) await spaces.updateSpace(accountId, id, { name: f.name as string });
      },
    };
  }
  const schedules = s.schedules;
  if (schedules) {
    out.schedule = {
      update: async (accountId, id, f) => {
        if (has(f, 'enabled'))
          await schedules.update(accountId, id, { enabled: f.enabled as boolean });
      },
    };
  }
  const setting = s.setting;
  if (setting) {
    out.setting = {
      update: async (accountId, key, f) => {
        if (has(f, 'value')) await setting(accountId, key, f.value);
      },
    };
  }
  return out;
}

function appendOnly(): Promise<void> {
  return Promise.reject(
    new NovaError('conflict', 'messages are append-only', { details: { reason: 'append_only' } }),
  );
}

/**
 * A message a replica wrote offline, under its thread's active leaf unless it names another
 * parent in the thread. No turn starts: the message is history, like an imported one; the user
 * asks for an answer on the Hub (`POST …/messages/:mid/answer`). A user message keeps author
 * `user` (the user typed it: memory and intent treat it as theirs). An answer from the device's
 * local model (FR-128; the caller checked the `local-runtime` scope) is an assistant message of
 * author `offline` with its model, under the message it answers.
 */
async function appendMessage(
  s: SyncWriterServices,
  accountId: string,
  id: string,
  fields: Record<string, unknown>,
  ctx: SyncWriteContext,
): Promise<void> {
  const body = fields.body as SyncMessageBody;
  const raw = s.db.raw;
  // The Hub's own time: a device must not backdate (or postdate) what it appends.
  const createdAt = new Date(ctx.receivedMs).toISOString();
  const now = createdAt;
  await s.db.transaction(() => {
    const t = raw
      .prepare(
        `SELECT active_leaf_id FROM thread WHERE id = ? AND account_id = ? AND deleted_at IS NULL
         AND temporary = 0 AND side = 0`,
      )
      .get(body.threadId, accountId) as { active_leaf_id: string | null } | undefined;
    if (!t) throw new NovaError('not_found', 'thread not found');
    if (raw.prepare('SELECT 1 FROM message WHERE id = ?').get(id))
      throw new NovaError('conflict', 'message exists', { details: { reason: 'append_only' } });
    let parent = body.parentId ?? t.active_leaf_id;
    if (body.parentId) {
      const p = raw
        .prepare('SELECT 1 FROM message WHERE id = ? AND thread_id = ? AND deleted_at IS NULL')
        .get(body.parentId, body.threadId);
      if (!p) throw new NovaError('validation', 'the parent message is not in this thread');
    }
    if (parent === undefined) parent = null;
    const answer = body.role === 'assistant';
    raw
      .prepare(
        `INSERT INTO message (id, thread_id, role, author_kind, provenance, status, model_id,
           parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'typed', 'complete', ?, ?, ?, ?)`,
      )
      .run(
        id,
        body.threadId,
        body.role,
        answer ? 'offline' : 'user',
        answer ? body.model : null,
        parent,
        createdAt,
        now,
      );
    raw
      .prepare(
        `INSERT INTO message_part (id, message_id, idx, type, content, created_at)
         VALUES (?, ?, 0, 'text', ?, ?)`,
      )
      .run(uuidv7(), id, body.text, createdAt);
    // Appended under the current leaf, it becomes the leaf; under an older message it is a
    // sibling version the user can switch to (FR-020).
    if (parent === t.active_leaf_id)
      raw
        .prepare('UPDATE thread SET active_leaf_id = ?, updated_at = ? WHERE id = ?')
        .run(id, now, body.threadId);
  });
  await s.events?.emit({
    name: 'chat.message.created',
    actor: body.role === 'assistant' ? 'system' : 'user',
    accountId,
    correlation: { threadId: body.threadId },
    payload: {
      threadId: body.threadId,
      messageId: id,
      turnId: null,
      role: body.role,
      status: 'complete',
      provenance: body.role === 'assistant' ? 'offline' : 'sync',
    },
  });
}
