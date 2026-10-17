// Chat Hub API: providers, models, account profile, threads, messages, the per-thread event
// stream, search and attachments (M1: FR-017, FR-018, FR-021, FR-023, FR-125), plus follow-up
// queues, message versions, branches, side chats and the thread tree (M2: FR-019, FR-020,
// FR-025, FR-026, FR-027, FR-033). Every route requires authentication and validates its input
// with the shared zod schemas (contracts/hub-api.md §1); services live in @nova/core.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  branchSchema,
  createProviderSchema,
  createThreadSchema,
  editMessageSchema,
  idSchema,
  listThreadsQuerySchema,
  regenerateSchema,
  selectVersionSchema,
  sendMessageSchema,
  sideChatSchema,
  updateThreadSchema,
  NovaError,
  type EventEnvelope,
  updateAccountSchema,
} from '@nova/shared';
import {
  readAttachmentBlob,
  type ChatService,
  type ModelRouter,
  type ProviderRegistry,
  type ThreadService,
} from '@nova/core';
import { schema, type NovaDatabase } from '@nova/storage';
import type { EventStore } from './event-store.ts';

export interface ChatRouteDeps {
  db: NovaDatabase;
  dataDir: string;
  events: EventStore;
  registry: ProviderRegistry;
  router: ModelRouter;
  threads: ThreadService;
  chat: ChatService;
  /** The authenticated account id; throws `token_required` without a principal. */
  accountOf: (req: FastifyRequest) => Promise<string>;
  /** Register an open stream so shutdown can end it. */
  trackStream: (end: () => void) => () => void;
}

/** Message posts carry base64 attachments (FR-021: 10 × 20 MB raw would be too much; ~30 MB). */
export const MESSAGE_BODY_LIMIT = 30 * 1024 * 1024;

const params = z.object({ id: idSchema });
const messageParams = z.object({ id: idSchema, mid: idSchema });
const queueParams = z.object({ id: idSchema, queuedId: idSchema });

// PATCH /account (contracts/hub-api.md §1). `avatar: null` clears the avatar; uploads are M2.

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: idSchema.optional(),
});

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const { db, events, registry, router, threads, chat, accountOf } = deps;

  // ---- providers & models -------------------------------------------------------------
  app.get('/api/v1/providers', async (req) => ({
    items: await registry.list(await accountOf(req)),
  }));

  app.post('/api/v1/providers', async (req, reply) => {
    const accountId = await accountOf(req);
    const body = createProviderSchema.parse(req.body);
    const view = await registry.create(accountId, body);
    void reply.status(201);
    return view;
  });

  app.delete('/api/v1/providers/:id', async (req) => {
    const accountId = await accountOf(req);
    await registry.remove(accountId, params.parse(req.params).id);
    return { ok: true };
  });

  app.post('/api/v1/providers/:id/test', async (req) => {
    const accountId = await accountOf(req);
    return registry.test(accountId, params.parse(req.params).id);
  });

  app.get('/api/v1/models', async (req) => ({
    items: await router.listModels(await accountOf(req)),
  }));

  // ---- account --------------------------------------------------------------------------
  app.patch('/api/v1/account', async (req) => {
    const accountId = await accountOf(req);
    const body = updateAccountSchema.parse(req.body);
    const set: Partial<typeof schema.account.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.displayName !== undefined) set.displayName = body.displayName.trim() || null;
    if (body.avatar === null) set.avatarPath = null;
    await db.transaction(() =>
      db.orm.update(schema.account).set(set).where(eq(schema.account.id, accountId)),
    );
    const rows = await db.orm
      .select({ displayName: schema.account.displayName })
      .from(schema.account)
      .where(eq(schema.account.id, accountId))
      .limit(1);
    return { accountId, displayName: rows[0]?.displayName ?? null };
  });

  // ---- threads ----------------------------------------------------------------------------
  app.get('/api/v1/threads', async (req) => {
    const accountId = await accountOf(req);
    return threads.list(accountId, listThreadsQuerySchema.parse(req.query));
  });

  app.post('/api/v1/threads', async (req, reply) => {
    const accountId = await accountOf(req);
    const view = await threads.create(accountId, createThreadSchema.parse(req.body ?? {}));
    void reply.status(201);
    return view;
  });

  app.get('/api/v1/threads/:id', async (req) => {
    const accountId = await accountOf(req);
    return threads.detail(accountId, params.parse(req.params).id);
  });

  app.patch('/api/v1/threads/:id', async (req) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    return threads.update(accountId, id, updateThreadSchema.parse(req.body));
  });

  // A running reply is stopped (and saved) first; a temporary chat is purged (FR-027).
  app.delete('/api/v1/threads/:id', async (req) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    await chat.deleteThread(accountId, id);
    return { ok: true };
  });

  app.post(
    '/api/v1/threads/:id/messages',
    { bodyLimit: MESSAGE_BODY_LIMIT },
    async (req, reply) => {
      const accountId = await accountOf(req);
      const { id } = params.parse(req.params);
      const res = await chat.send(accountId, id, sendMessageSchema.parse(req.body));
      void reply.status(202);
      return res;
    },
  );

  app.post('/api/v1/threads/:id/cancel', async (req) => {
    const accountId = await accountOf(req);
    const cancelled = await chat.cancel(accountId, params.parse(req.params).id);
    return { ok: true, cancelled };
  });

  // ---- follow-up queue (FR-019) ---------------------------------------------------------
  app.get('/api/v1/threads/:id/queue', async (req) => {
    const accountId = await accountOf(req);
    return { items: await chat.listQueue(accountId, params.parse(req.params).id) };
  });

  app.delete('/api/v1/threads/:id/queue/:queuedId', async (req) => {
    const accountId = await accountOf(req);
    const { id, queuedId } = queueParams.parse(req.params);
    await chat.cancelQueued(accountId, id, queuedId);
    return { ok: true };
  });

  // ---- versions, branches, side chats (FR-020, FR-026, FR-033) ---------------------------
  app.post('/api/v1/threads/:id/messages/:mid/edit', async (req, reply) => {
    const accountId = await accountOf(req);
    const { id, mid } = messageParams.parse(req.params);
    const res = await chat.edit(accountId, id, mid, editMessageSchema.parse(req.body));
    void reply.status(202);
    return res;
  });

  app.post('/api/v1/threads/:id/messages/:mid/regenerate', async (req, reply) => {
    const accountId = await accountOf(req);
    const { id, mid } = messageParams.parse(req.params);
    const res = await chat.regenerate(accountId, id, mid, regenerateSchema.parse(req.body ?? {}));
    void reply.status(202);
    return res;
  });

  app.post('/api/v1/threads/:id/active', async (req) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    const body = selectVersionSchema.parse(req.body);
    return chat.selectVersion(accountId, id, body.messageId);
  });

  app.delete('/api/v1/threads/:id/messages/:mid', async (req) => {
    const accountId = await accountOf(req);
    const { id, mid } = messageParams.parse(req.params);
    await chat.deleteMessage(accountId, id, mid);
    return { ok: true };
  });

  app.post('/api/v1/threads/:id/branch', async (req, reply) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    const view = await threads.branch(accountId, id, branchSchema.parse(req.body));
    void reply.status(201);
    return view;
  });

  app.get('/api/v1/threads/:id/tree', async (req) => {
    const accountId = await accountOf(req);
    return threads.tree(accountId, params.parse(req.params).id);
  });

  app.post('/api/v1/threads/:id/side', async (req, reply) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    const res = await chat.sideChat(accountId, id, sideChatSchema.parse(req.body));
    void reply.status(201);
    return res;
  });

  // Per-thread SSE: persisted events after the cursor, then live ones (including ephemeral
  // `chat.delta`) correlated with this thread (contracts/hub-api.md §5).
  app.get('/api/v1/threads/:id/stream', async (req, reply) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    await threads.row(accountId, id);
    const header = req.headers['last-event-id'];
    const query = z.object({ after: z.string().max(100).optional() }).parse(req.query);
    const after =
      (typeof header === 'string' && header ? header : undefined) ?? query.after ?? null;
    return openStream(
      req,
      reply,
      deps,
      (e) => e.correlation?.threadId === id,
      async (send) => {
        if (!after) return;
        let cursor: string | null = after;
        for (;;) {
          const page = await events.since(cursor, 500, { threadId: id });
          for (const e of page) send(e);
          if (page.length < 500) break;
          cursor = page.at(-1)!.id;
        }
      },
    );
  });

  // ---- search & attachments -------------------------------------------------------------
  app.get('/api/v1/search', async (req) => {
    const accountId = await accountOf(req);
    const q = searchQuerySchema.parse(req.query);
    return { items: threads.search(accountId, q.q, { limit: q.limit, projectId: q.projectId }) };
  });

  app.get('/api/v1/attachments/:id', async (req, reply) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    const { attachment, thread } = schema;
    const rows = await db.orm
      .select({
        name: attachment.name,
        mime: attachment.mime,
        blobPath: attachment.blobPath,
      })
      .from(attachment)
      .innerJoin(thread, eq(thread.id, attachment.threadId))
      .where(and(eq(attachment.id, id), eq(thread.accountId, accountId), isNull(thread.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'attachment not found');
    const bytes = readAttachmentBlob(deps.dataDir, row.blobPath);
    const mime = row.mime ?? 'application/octet-stream';
    const isImage = mime.startsWith('image/');
    const textual = mime.startsWith('text/') || mime === 'application/json';
    void reply
      .header('Content-Type', textual ? `${mime}; charset=utf-8` : mime)
      .header(
        'Content-Disposition',
        contentDisposition(isImage ? 'inline' : 'attachment', row.name),
      )
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600');
    return reply.send(bytes);
  });
}

/**
 * Write an SSE response: replay first (live events are queued meanwhile and de-duplicated),
 * then live delivery until the client leaves or the Hub stops.
 */
export async function openStream(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<ChatRouteDeps, 'events' | 'trackStream'>,
  filter: (e: EventEnvelope) => boolean,
  replay: (send: (e: EventEnvelope) => void) => Promise<void>,
): Promise<FastifyReply> {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush the headers now: with nothing to replay the client would otherwise wait for an event.
  reply.raw.write(': connected\n\n');
  // Ids sent during replay; a live publish can race the replay query, so they are skipped once.
  const seen = new Set<string>();
  let replaying = true;
  const send = (e: EventEnvelope) => {
    if (seen.has(e.id)) return;
    if (replaying) seen.add(e.id);
    reply.raw.write(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const queued: EventEnvelope[] = [];
  const off = deps.events.bus.subscribe('*', (e) => {
    if (!filter(e)) return;
    if (replaying) queued.push(e);
    else send(e);
  });
  let closed = false;
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    off();
    untrack();
  };
  const untrack = deps.trackStream(() => {
    cleanup();
    reply.raw.end();
  });
  req.raw.on('close', cleanup);
  try {
    await replay(send);
  } finally {
    replaying = false;
    for (const e of queued) send(e);
  }
  return reply;
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
