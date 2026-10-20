// Writes made while the Hub is unreachable (FR-112, FR-109): on a device with an offline copy,
// the app's own requests to send a message, start a chat, rename (pin, archive, move) a chat,
// change a project's name or instructions and save a page become sync changes in the outbound
// queue, clocked by this device: messages as appends (the Hub records them as written; they
// start no turn), the rest as per-field last-writer-wins changes whose `base` is the clock of the
// value the edit started from. The request then succeeds as the Hub would have answered it, from
// the copy with the change laid over, so every view keeps working. Anything else fails as before;
// without a copy nothing is queued (offline views are read-only).
import { defineMessages } from '@nova/i18n';
import {
  uuidv7,
  type CreateThreadRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type SyncKind,
  type SyncOp,
} from '@nova/shared';
import { ApiError, type HubRequest } from '../api.ts';
import type { Replica } from '../replica/replica.ts';
import {
  currentFields,
  pageView,
  pendingQueue,
  projectView,
  spaceView,
  threadView,
  type ViewSource,
} from '../replica/views.ts';
import type { NewQueueItem, OutboundQueue, QueueItem, QueueSubject } from './queue.ts';
import { splitPath } from './reads.ts';

export interface WriteContext {
  source: ViewSource;
  replica: Replica;
  deviceId: string;
  /** A clock value for this device's next change. */
  tick: () => string;
  queue: OutboundQueue;
}

/** Refusals the app's request gets back, read when thrown (shown as the request's error). */
const WRITE_TEXT = defineMessages('offline.writes', {
  noFiles: 'Files cannot be sent while the Hub is unreachable. Send them when it is back.',
  beingSent: 'It is being sent right now.',
});

/** A name as a change's subject keeps it: trimmed, or null when there is none. */
const named = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null);

/** The clock of the value an edit starts from: this device's last waiting change, or the copy's. */
function baseOf(ctx: WriteContext, kind: SyncKind, id: string, field: string): string | null {
  let base = ctx.replica.entity(kind, id)?.fields[field]?.hlc ?? null;
  for (const item of ctx.source.pending)
    for (const op of item.ops)
      if (op.kind === kind && op.id === id && op.field === field) base = op.hlc;
  return base;
}

function edits(
  ctx: WriteContext,
  kind: SyncKind,
  id: string,
  fields: Record<string, unknown>,
): SyncOp[] {
  return Object.entries(fields).map(([field, value]) => ({
    kind,
    id,
    field,
    value,
    hlc: ctx.tick(),
    base: baseOf(ctx, kind, id, field),
  }));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function offlineError(message: string): ApiError {
  return new ApiError(503, { code: 'offline', message, retryable: true });
}

async function enqueue(
  ctx: WriteContext,
  item: Omit<NewQueueItem, 'deviceId'>,
): Promise<QueueItem> {
  const added = await ctx.queue.add({ ...item, deviceId: ctx.deviceId });
  // Later reads see it at once.
  ctx.source = { ...ctx.source, pending: ctx.queue.pending() };
  return added;
}

/** Request fields to the copy's field names (protocol names, not UI text). */
const THREAD_FIELDS: Record<string, string> = {
  // eslint-disable-next-line nova-i18n/no-literal-ui-text -- a sync field name
  title: 'title',
  pinned: 'pinned',
  archived: 'archived',
  projectId: 'project',
};

function chatEditSubject(body: Record<string, unknown>, title: string | null): QueueSubject {
  const name = named(title);
  if ('title' in body) return { action: 'renameChat', name, to: named(body.title) };
  if ('archived' in body) return { action: body.archived ? 'archiveChat' : 'restoreChat', name };
  if ('pinned' in body) return { action: body.pinned ? 'pinChat' : 'unpinChat', name };
  return { action: 'moveChat', name };
}

/**
 * Take over a write the Hub could not be reached for: the Hub's answer as it would have been, or
 * null to let the request fail. Rejects with a sentence when it cannot be kept for later.
 */
export async function takeWrite(
  req: HubRequest,
  ctx: WriteContext,
): Promise<{ data: unknown } | null> {
  const s = splitPath(req.path);
  if (!s) return null;
  const [head, id, sub, subId, extra] = s.parts;
  const body = isObj(req.body) ? req.body : {};

  // ---- a new chat (POST /threads) ----------------------------------------------------------------
  if (req.method === 'POST' && head === 'threads' && !id) {
    const b = body as Partial<CreateThreadRequest>;
    if ((b.mode && b.mode !== 'chat') || b.temporary) return null;
    const threadId = uuidv7();
    const fields: Record<string, unknown> = { title: b.title?.trim() ? b.title.trim() : null };
    if (b.projectId) fields.project = b.projectId;
    await enqueue(ctx, {
      kind: 'chat',
      subject: { action: 'newChat', name: named(b.title) },
      threadId,
      entityId: threadId,
      text: null,
      model: null,
      ops: Object.entries(fields).map(([field, value]) => ({
        kind: 'thread' as const,
        id: threadId,
        field,
        value,
        hlc: ctx.tick(),
        base: null,
      })),
    });
    return { data: threadView(ctx.source, threadId) };
  }

  // ---- a message (POST /threads/:id/messages) ----------------------------------------------------
  if (req.method === 'POST' && head === 'threads' && id && sub === 'messages' && !subId) {
    const b = body as Partial<SendMessageRequest>;
    const thread = threadView(ctx.source, id);
    if (!thread) return null;
    if (b.attachments?.length) throw offlineError(WRITE_TEXT.noFiles);
    const text = typeof b.text === 'string' ? b.text : '';
    if (!text.trim()) return null;
    const messageId = uuidv7();
    await enqueue(ctx, {
      kind: 'message',
      subject: { action: 'message', name: named(thread.title) },
      threadId: id,
      entityId: messageId,
      text,
      model: null,
      ops: [
        {
          kind: 'message',
          id: messageId,
          field: 'body',
          value: { threadId: id, role: 'user', text },
          hlc: ctx.tick(),
          base: null,
        },
      ],
    });
    const res: SendMessageResponse = {
      disposition: 'queued',
      turnId: null,
      userMessageId: messageId,
      assistantMessageId: null,
      queuePosition: pendingQueue(ctx.source, id).length,
    };
    return { data: res };
  }

  // ---- a message written here, cancelled from the queue strip -------------------------------------
  if (req.method === 'DELETE' && head === 'threads' && id && sub === 'queue' && subId && !extra) {
    const item = ctx.queue
      .pending()
      .find((i) => i.kind === 'message' && i.threadId === id && i.entityId === subId);
    if (!item) return null;
    if (!(await ctx.queue.discard(item.id)))
      throw new ApiError(409, {
        code: 'conflict',
        message: WRITE_TEXT.beingSent,
        retryable: true,
      });
    return { data: { ok: true } };
  }

  // ---- a chat's title, pin, archive or project (PATCH /threads/:id) --------------------------------
  if (req.method === 'PATCH' && head === 'threads' && id && !sub) {
    const keys = Object.keys(body).filter((k) => k !== 'unread');
    if (!keys.length || keys.some((k) => !(k in THREAD_FIELDS))) return null;
    const before = threadView(ctx.source, id);
    if (!before) return null;
    const fields = Object.fromEntries(keys.map((k) => [THREAD_FIELDS[k]!, body[k] ?? null]));
    await enqueue(ctx, {
      kind: 'chat_edit',
      subject: chatEditSubject(body, before.title),
      threadId: id,
      entityId: id,
      text: null,
      model: null,
      ops: edits(ctx, 'thread', id, fields),
    });
    return { data: threadView(ctx.source, id) };
  }

  // ---- a project's name or instructions (PATCH /projects/:id) --------------------------------------
  if (req.method === 'PATCH' && head === 'projects' && id && !sub) {
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => k !== 'name' && k !== 'instructions')) return null;
    const before = currentFields(ctx.source, 'project', id);
    if (!before || !ctx.replica.entity('project', id)) return null;
    const name = named(before.name);
    await enqueue(ctx, {
      kind: 'project',
      subject:
        'instructions' in body
          ? { action: 'projectInstructions', name }
          : { action: 'renameProject', name, to: named(body.name) },
      threadId: null,
      entityId: id,
      text: null,
      model: null,
      ops: edits(ctx, 'project', id, body),
    });
    return { data: projectView(ctx.source, id) };
  }

  // ---- a space's name (PATCH /spaces/:id) ----------------------------------------------------------
  if (req.method === 'PATCH' && head === 'spaces' && id && !sub) {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'name' || typeof body.name !== 'string') return null;
    const before = spaceView(ctx.source, id);
    if (!before || !ctx.replica.entity('space', id)) return null;
    await enqueue(ctx, {
      kind: 'space',
      subject: {
        action: 'renameSpace',
        // The name it has, not the view's stand-in for none.
        name: named(
          currentFields(ctx.source, 'space', id)?.name ?? ctx.source.hints.space(id)?.name,
        ),
        to: named(body.name),
      },
      threadId: null,
      entityId: id,
      text: null,
      model: null,
      ops: edits(ctx, 'space', id, { name: body.name }),
    });
    return { data: spaceView(ctx.source, id) };
  }

  // ---- a page's title or content (PUT /spaces/:sid/pages/:pid) -------------------------------------
  if (req.method === 'PUT' && head === 'spaces' && id && sub === 'pages' && subId && !extra) {
    const before = pageView(ctx.source, id, subId);
    if (!before) return null;
    const fields: Record<string, unknown> = {};
    if (typeof body.title === 'string') fields.title = body.title;
    if (typeof body.content === 'string') fields.content = body.content;
    if (!Object.keys(fields).length) return null;
    await enqueue(ctx, {
      kind: 'page',
      subject: {
        action: 'editPage',
        name: named(
          currentFields(ctx.source, 'page', subId)?.title ?? ctx.source.hints.page(subId)?.title,
        ),
      },
      threadId: null,
      entityId: subId,
      text: null,
      model: null,
      ops: edits(ctx, 'page', subId, fields),
    });
    return { data: pageView(ctx.source, id, subId) };
  }

  return null;
}
