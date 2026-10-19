// Sync area (M7; FR-109, FR-129, FR-112; docs/13 §2, ADR-010, ADR-036, ADR-095 decisions 1-3).
// The Hub is canonical: a client whose device session has the `offline-replica` scope keeps a
// local replica and syncs it here: a paged snapshot, the change feed after a cursor, and pushed
// field ops merged last-writer-wins by HLC. Without the scope those three routes answer 403
// `policy_denied` `{reason: replica_not_granted}`; a revoked device's sessions are gone, so they
// answer 401. The merge log and restore take any session of the account while sync is on (the
// owner may restore from anywhere); the replica list and reset take any session. The area also
// owns the idempotency hooks every mutating route shares (decision 2; replay is opt-in per route)
// and feeds the change feed from the event bus.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  idSchema,
  regenerateSchema,
  syncChangesQuerySchema,
  syncMergeLogQuerySchema,
  syncPushSchema,
  syncSnapshotQuerySchema,
} from '@nova/shared';
import {
  IDEMPOTENCY_KEY_PATTERN,
  IdempotencyStore,
  SyncService,
  hashRequestBody,
  serviceWriters,
  type AuditSink,
  type ChatService,
  type IdempotencyRef,
  type SyncWriterServices,
} from '@nova/core';
import { deviceScopes, type DeviceScopes, type Principal } from './auth.ts';
import type { HubArea, HubContext } from './hub-context.ts';

/** The services sync writes through; the lead hands over those built after this area. */
export type SyncServices = Omit<SyncWriterServices, 'db' | 'events'>;

export interface IdempotencyHooks {
  store: IdempotencyStore;
  /** `app.addHook('preHandler', …)`: claims the key, or answers a repeat. */
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
  /** `app.addHook('onSend', …)`: keeps the first answer. */
  onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
  /** `app.addHook('onResponse', …)`: forgets a key whose answer never got kept. */
  onResponse: (req: FastifyRequest) => Promise<void>;
}

export interface SyncArea extends HubArea {
  service: SyncService;
  idempotency: IdempotencyHooks;
  /** Decision 3: the device and scopes behind a request (null for a session of no device). */
  deviceScopes: (req: FastifyRequest) => DeviceScopes | null;
  useServices(services: SyncServices): void;
  useAudit(audit: AuditSink): void;
  /** The chat loop, for answering a message written offline (`…/messages/:mid/answer`). */
  useChat(chat: Pick<ChatService, 'answer'>): void;
}

export interface SyncDeps {
  audit?: AuditSink;
  services?: SyncServices;
  now?: () => Date;
  /** The periodic sweep (default 5 minutes). */
  sweepIntervalMs?: number;
  /** Expired idempotency keys are removed this often (default 1 hour). */
  idempotencySweepMs?: number;
  /** Seed the feed and start the sweep (default true; tests may drive it). */
  start?: boolean;
}

const REPLICA_SCOPE = 'offline-replica';
/** A device that may run a local model and bring back its answers (FR-128). */
const LOCAL_RUNTIME_SCOPE = 'local-runtime';
const answerParams = z.object({ id: idSchema, mid: idSchema });
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes whose first answer may be replayed (FR-112): the writes a client queues while offline.
 * Replay is opt-in: on every other route a key is remembered and a repeat is refused
 * (`idempotency_not_replayable`) without the answer ever being kept, so a route that hands out a
 * credential cannot leave it in the store, including one added later. A route may also opt in
 * with `config: { idempotentReplay: true }`. The store itself never keeps an answer that carries
 * a credential, whatever the route.
 */
export const REPLAYABLE_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/sync/push',
  'POST /api/v1/threads',
  'PATCH /api/v1/threads/:id',
  'DELETE /api/v1/threads/:id',
  'POST /api/v1/threads/:id/messages',
  'POST /api/v1/threads/:id/messages/:mid/edit',
  'POST /api/v1/projects',
  'PATCH /api/v1/projects/:id',
  'DELETE /api/v1/projects/:id',
  'POST /api/v1/memory/items',
  'PATCH /api/v1/memory/items/:id',
  'DELETE /api/v1/memory/items/:id',
  'POST /api/v1/spaces',
  'POST /api/v1/spaces/:id/pages',
  'PUT /api/v1/spaces/:id/pages/:pageId',
  'PATCH /api/v1/spaces/:id/pages/:pageId',
  'DELETE /api/v1/spaces/:id/pages/:pageId',
  'POST /api/v1/spaces/:id/pages/:pageId/comments',
  'POST /api/v1/approvals',
  'POST /api/v1/requests/:id/respond',
  'POST /api/v1/runs',
]);

function replayAllowed(req: FastifyRequest): boolean {
  const config = req.routeOptions.config as { idempotentReplay?: unknown } | undefined;
  if (config?.idempotentReplay === true) return true;
  return REPLAYABLE_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ''}`);
}
const entryParams = z.object({ id: z.string().min(1).max(100) });
const deviceParams = z.object({ id: z.string().min(1).max(100) });

/** The idempotency principal: the device of a device session, else the session itself. */
function principalOf(req: { principal?: Principal | null }): string | null {
  const p = req.principal;
  if (!p) return null;
  return p.deviceId ? `device:${p.deviceId}` : `token:${p.tokenId}`;
}

/**
 * The preHandler/onSend pair for `Idempotency-Key` (FR-112). Only signed-in requests take part:
 * the public routes authenticate another way and have no principal to scope a key to.
 */
export function idempotencyHooks(store: IdempotencyStore): IdempotencyHooks {
  const pending = new WeakMap<FastifyRequest, { ref: IdempotencyRef; replay: boolean }>();
  return {
    store,
    preHandler: async (req, reply) => {
      if (!MUTATING.has(req.method)) return undefined;
      const header = req.headers['idempotency-key'];
      if (header === undefined) return undefined;
      const principal = principalOf(req);
      if (!principal) return undefined;
      const key = Array.isArray(header) ? header[0] : header;
      if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key))
        throw new NovaError(
          'validation',
          'Idempotency-Key must be 1-200 visible ASCII characters',
          {
            details: { reason: 'idempotency_key_invalid', field: 'Idempotency-Key' },
          },
        );
      const ref: IdempotencyRef = {
        principal,
        key,
        method: req.method,
        path: req.url.split('?')[0] ?? req.url,
      };
      const accountId = req.principal?.accountId ?? null;
      const start = await store.begin(ref, hashRequestBody(req.body), accountId);
      if (start.kind === 'proceed') {
        pending.set(req, { ref, replay: replayAllowed(req) });
        return undefined;
      }
      if (start.kind === 'replay') {
        void reply.status(start.status).header('idempotent-replay', 'true');
        if (start.contentType) void reply.type(start.contentType);
        return reply.send(start.body);
      }
      const messages = {
        idempotency_key_reused: 'this Idempotency-Key was used with a different request',
        idempotency_in_flight: 'a request with this Idempotency-Key is still running',
        idempotency_not_replayable: 'this Idempotency-Key was used; its answer cannot be repeated',
      } as const;
      throw new NovaError('conflict', messages[start.reason], {
        details: { reason: start.reason },
        retryable: start.reason === 'idempotency_in_flight',
      });
    },
    onSend: async (req, reply, payload) => {
      const claim = pending.get(req);
      if (!claim) return payload;
      pending.delete(req);
      const { ref } = claim;
      const status = reply.statusCode;
      // A failure worth retrying is forgotten, so the retry runs.
      if (status >= 500 || status === 429) {
        await store.abandon(ref);
        return payload;
      }
      const cache = String(reply.getHeader('cache-control') ?? '');
      const type = reply.getHeader('content-type');
      // Only a route that opted in keeps its answer; one marked no-store carries one-time
      // material and never does. The key is kept either way, so the effect is never repeated.
      const body =
        claim.replay && typeof payload === 'string' && !/no-store/i.test(cache) ? payload : null;
      await store.complete(ref, {
        status,
        body,
        contentType: typeof type === 'string' ? type : null,
      });
      return payload;
    },
    onResponse: async (req) => {
      const claim = pending.get(req);
      if (!claim) return;
      pending.delete(req);
      await store.abandon(claim.ref);
    },
  };
}

export function setupSync(ctx: HubContext, deps: SyncDeps = {}): Promise<SyncArea> {
  const log = ctx.log.child('sync');
  let audit = deps.audit;
  let services: SyncServices = { threads: ctx.threads, ...deps.services };
  const writerServices = (): SyncWriterServices => ({
    db: ctx.db,
    events: ctx.events,
    ...services,
  });
  const service = new SyncService({
    db: ctx.db,
    events: ctx.events,
    log,
    ...(audit ? { audit } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sweepIntervalMs ? { sweepIntervalMs: deps.sweepIntervalMs } : {}),
    writers: serviceWriters(writerServices()),
    settings: {
      maxSkewSeconds: () => ctx.setting('sync.maxSkewSeconds'),
      mergeLogDays: () => ctx.setting('sync.mergeLogDays'),
      offlineAfterMinutes: () => ctx.setting('sync.offlineAfterMinutes'),
    },
  });
  const store = new IdempotencyStore({ db: ctx.db, ...(deps.now ? { now: deps.now } : {}) });
  const idempotency = idempotencyHooks(store);

  // Every Hub-side write to a synced entity reaches the feed through the bus (the services'
  // events; ThreadService and ProjectService emit theirs for sync).
  const offEvents = ctx.events.bus.subscribe('*', (e) => service.onEvent(e));
  // A revoked device is told (`sync.replica.revoked`); its sessions are gone, so its calls get 401.
  const offRevoked = ctx.events.bus.subscribe('device.status.changed', (e) => {
    const deviceId = e.payload.deviceId;
    if (e.payload.status !== 'revoked' || typeof deviceId !== 'string' || !e.accountId) return;
    service
      .replicaRevoked(e.accountId, deviceId, 'revoked')
      .catch((err: unknown) => log.warn('replica revocation not announced', { err }));
  });
  // Taking the scope away ends the replica the same way (the device must wipe its copy).
  const offScopes = ctx.events.bus.subscribe('device.scopes.changed', (e) => {
    const { deviceId, scopes } = e.payload;
    if (typeof deviceId !== 'string' || !Array.isArray(scopes) || !e.accountId) return;
    if (scopes.includes(REPLICA_SCOPE)) return;
    service
      .replicaRevoked(e.accountId, deviceId, 'scope_removed')
      .catch((err: unknown) => log.warn('replica scope removal not announced', { err }));
  });
  if (deps.start ?? true) service.start();
  const idemTimer = setInterval(
    () => {
      store.sweep().catch((err: unknown) => log.warn('idempotency sweep failed', { err }));
    },
    deps.idempotencySweepMs ?? 60 * 60_000,
  );
  idemTimer.unref();
  void store.sweep().catch((err: unknown) => log.warn('idempotency sweep failed', { err }));

  ctx.diagnostics.add('sync', () => {
    const row = ctx.db.raw
      .prepare(
        `SELECT (SELECT count(*) FROM sync_field) AS fields,
                (SELECT count(*) FROM sync_replica WHERE revoked_at IS NULL) AS replicas,
                (SELECT count(*) FROM sync_merge_entry WHERE status = 'open') AS openConflicts,
                (SELECT count(*) FROM idempotency_key) AS idempotencyKeys`,
      )
      .get() as Record<string, number>;
    return Promise.resolve({ ...row, cursor: service.cursor(), clock: service.clock() });
  });

  /** The merge log and restore: any session of the account, while sync is on. */
  async function owner(req: FastifyRequest): Promise<string> {
    const accountId = await ctx.accountOf(req);
    if (!(await ctx.setting('sync.enabled')))
      throw new NovaError('policy_denied', 'sync is turned off on this Hub', {
        details: { reason: 'sync_disabled' },
      });
    return accountId;
  }

  /** The replica routes: a device session with `offline-replica`, while sync is on. */
  async function replica(
    req: FastifyRequest,
  ): Promise<{ accountId: string; deviceId: string; localRuntime: boolean }> {
    const accountId = await ctx.accountOf(req);
    const device = deviceScopes(req);
    if (!device || !device.scopes.includes(REPLICA_SCOPE))
      throw new NovaError('policy_denied', 'this device has no offline replica', {
        details: { reason: 'replica_not_granted' },
        action: 'Grant the device an offline replica in Devices',
      });
    if (!(await ctx.setting('sync.enabled')))
      throw new NovaError('policy_denied', 'sync is turned off on this Hub', {
        details: { reason: 'sync_disabled' },
      });
    return {
      accountId,
      deviceId: device.deviceId,
      localRuntime: device.scopes.includes(LOCAL_RUNTIME_SCOPE),
    };
  }

  let chat: Pick<ChatService, 'answer'> | null = null;

  const actorOf = (req: FastifyRequest) => ({
    actor: 'user',
    deviceId: deviceScopes(req)?.deviceId ?? null,
  });

  return Promise.resolve({
    service,
    idempotency,
    deviceScopes: (req) => deviceScopes(req),
    useServices(next) {
      services = { ...services, ...next };
      service.useWriters(serviceWriters(writerServices()));
    },
    useAudit(next) {
      audit = next;
      service.useAudit(next);
    },
    useChat(next) {
      chat = next;
    },
    register(app) {
      app.get('/api/v1/sync/snapshot', async (req) => {
        const { accountId, deviceId } = await replica(req);
        const q = syncSnapshotQuerySchema.parse(req.query);
        return service.snapshot(accountId, deviceId, q);
      });

      app.get('/api/v1/sync/changes', async (req) => {
        const { accountId, deviceId } = await replica(req);
        const q = syncChangesQuerySchema.parse(req.query);
        return service.changes(accountId, deviceId, q.since, q.limit);
      });

      app.post('/api/v1/sync/push', async (req) => {
        const { accountId, deviceId, localRuntime } = await replica(req);
        const body = syncPushSchema.parse(req.body);
        // A replica pushes only its own changes.
        if (body.deviceId !== deviceId)
          throw new NovaError('policy_denied', 'deviceId is not this session’s device', {
            details: { reason: 'device_mismatch', field: 'deviceId' },
          });
        return service.push(accountId, deviceId, body.ops, { localRuntime });
      });

      // A message written offline was recorded without a turn; this asks for its answer through
      // the normal chat loop (FR-112). Any session of the account; a queued retry replays.
      app.post(
        '/api/v1/threads/:id/messages/:mid/answer',
        { config: { idempotentReplay: true } },
        async (req, reply) => {
          const accountId = await ctx.accountOf(req);
          const { id, mid } = answerParams.parse(req.params);
          const body = regenerateSchema.parse(req.body ?? {});
          if (!chat) throw new NovaError('server_error', 'the chat loop is not ready');
          const res = await chat.answer(accountId, id, mid, body);
          void reply.status(202);
          return res;
        },
      );

      app.get('/api/v1/sync/merge-log', async (req) => {
        const accountId = await owner(req);
        const q = syncMergeLogQuerySchema.parse(req.query);
        return { items: await service.mergeLog(accountId, q) };
      });

      app.post('/api/v1/sync/merge-log/:id/restore', async (req) => {
        const accountId = await owner(req);
        const { id } = entryParams.parse(req.params);
        return service.restore(accountId, id, actorOf(req));
      });

      app.get('/api/v1/sync/devices', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await service.replicas(accountId) };
      });

      app.post('/api/v1/sync/devices/:id/reset', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = deviceParams.parse(req.params);
        return service.resetReplica(accountId, id, actorOf(req));
      });
    },
    async close() {
      offEvents();
      offRevoked();
      offScopes();
      clearInterval(idemTimer);
      await service.close();
    },
  });
}
