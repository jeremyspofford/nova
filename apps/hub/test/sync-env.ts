// A Fastify app with the sync area (FR-109, FR-129, FR-112) as app.ts wires it: the Hub's own
// bearer authentication through AuthService (device sessions carry their device and scopes), the
// idempotency hooks registered before the routes, the Hub's error mapping, the spaces area (pages
// are the notes replicas edit), the core services sync writes through, and the Add Device service
// for real revocation and scope changes. Device sessions are issued the way Add Device issues them.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type SettingKey,
} from '@nova/shared';
import {
  MemoryService,
  formatHlc,
  PairingService,
  ProjectService,
  ThreadService,
  type AuditRecord,
  type ModelRouter,
} from '@nova/core';
import { hashToken, newToken } from '@nova/security';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { requireAuth } from '../src/app.ts';
import { AuthService } from '../src/auth.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupSpaces, type SpacesArea } from '../src/spaces.ts';
import { setupSync, type SyncArea, type SyncDeps } from '../src/sync.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000005a1';
export const OTHER = '01920000-0000-7000-8000-0000000005a2';

export interface Session {
  token: string;
  deviceId: string | null;
  headers: Record<string, string>;
}

export interface SyncHub {
  app: FastifyInstance;
  area: SyncArea;
  spacesArea: SpacesArea;
  db: NovaDatabase;
  events: EventStore;
  auth: AuthService;
  pairing: PairingService;
  threads: ThreadService;
  projects: ProjectService;
  memory: MemoryService;
  audit: AuditRecord[];
  diagnostics: DiagnosticsRegistry;
  settings: Partial<Record<SettingKey, unknown>>;
  clock: { t: number };
  /** The owner's own browser session (no device). */
  owner: Session;
  /** Two replicas of the owner and a device without the scope. */
  a: Session;
  b: Session;
  plain: Session;
  /** A device session of a fresh device. */
  device: (scopes: string[], accountId?: string) => Session;
  /** Another session of an existing device (it signed in again). */
  sessionFor: (deviceId: string) => Session;
  hlc: (s: Session, offsetMs?: number, c?: number) => string;
  call: (
    s: Session | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function syncHub(
  deps: SyncDeps = {},
  /** More routes or areas on the same app; may return their cleanup. */
  extraRoutes?: (
    app: FastifyInstance,
    ctx: HubContext,
  ) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>,
): Promise<SyncHub> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const iso = new Date(clock.t - 60_000).toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, iso, iso);
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Member', ?, ?)",
    )
    .run(OTHER, new Date(clock.t).toISOString(), iso);
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-sync-'));
  const events = new EventStore(db);
  const auth = new AuthService(db);
  const audit: AuditRecord[] = [];
  const auditSink = { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) };
  const settings: Partial<Record<SettingKey, unknown>> = {};
  const log = new Logger({ module: 'hub', sinks: [] });
  // Threads never need a model here: no default model, no router behind it.
  const router = { firstModel: () => Promise.resolve(null) } as unknown as ModelRouter;
  const threads = new ThreadService({ db, router, events });
  const projects = new ProjectService({ db, events });
  const memory = new MemoryService({ db, events });
  const pairing = new PairingService({ db, events, audit: auditSink });
  const diagnostics = new DiagnosticsRegistry();
  const ctx = {
    config: {} as never,
    db,
    log,
    events,
    secrets: new MemorySecretStore(),
    dataDir: join(dir, 'data'),
    registry: {} as never,
    router,
    nodes: {} as never,
    threads,
    setting: (key: SettingKey) =>
      Promise.resolve((key in settings ? settings[key] : SETTINGS[key].default) as never),
    accountOf: (req: Parameters<typeof requireAuth>[0]) => {
      const p = requireAuth(req);
      if (!p.accountId) return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(p.accountId);
    },
    diagnostics,
  } as unknown as HubContext;

  const spacesArea = await setupSpaces(ctx, { audit: auditSink });
  const area = await setupSync(ctx, {
    audit: auditSink,
    now,
    services: { projects, memory, spaces: spacesArea.spaces },
    ...deps,
  });
  const app = Fastify({ logger: false });
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    req.principal = h?.startsWith('Bearer ') ? await auth.verify(h.slice(7).trim()) : null;
  });
  // What app.ts registers globally, before every route (ADR-095 decision 2).
  app.addHook('preHandler', area.idempotency.preHandler);
  app.addHook('onSend', area.idempotency.onSend);
  app.addHook('onResponse', area.idempotency.onResponse);
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: 'invalid' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  spacesArea.register(app);
  area.register(app);
  const extraClose = await extraRoutes?.(app, ctx);
  await app.ready();

  const session = (accountId: string, deviceId: string | null): Session => {
    const token = newToken('session');
    const tokenId = uuidv7();
    const at = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO auth_token (id, kind, token_hash, account_id, created_at, expires_at)
         VALUES (?, 'session', ?, ?, ?, ?)`,
      )
      .run(
        tokenId,
        hashToken(token),
        accountId,
        at,
        new Date(Date.now() + 86_400_000).toISOString(),
      );
    if (deviceId)
      db.raw
        .prepare(
          'INSERT INTO device_session (token_id, device_id, account_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(tokenId, deviceId, accountId, at);
    return { token, deviceId, headers: { authorization: `Bearer ${token}` } };
  };
  const device = (scopes: string[], accountId = ACCOUNT): Session => {
    const id = uuidv7();
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key,
           roles, scopes, status, offline_replica, created_at, updated_at)
         VALUES (?, ?, ?, 'client', 'web', ?, ?, '["client"]', ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        accountId,
        `Phone ${id.slice(-4)}`,
        randomUUID(),
        randomUUID(),
        JSON.stringify(scopes),
        scopes.includes('offline-replica') ? 1 : 0,
        iso,
        iso,
      );
    return session(accountId, id);
  };

  return {
    app,
    area,
    spacesArea,
    db,
    events,
    auth,
    pairing,
    threads,
    projects,
    memory,
    audit,
    diagnostics,
    settings,
    clock,
    owner: session(ACCOUNT, null),
    a: device(['offline-replica']),
    b: device(['offline-replica']),
    plain: device([]),
    device,
    sessionFor: (deviceId) => session(ACCOUNT, deviceId),
    hlc: (s, offsetMs = 0, c = 0) =>
      formatHlc({ pt: clock.t + offsetMs, c, node: s.deviceId ?? 'none' }),
    call: (s, method, url, payload, headers = {}) =>
      app.inject({
        method,
        url,
        headers: { ...(s?.headers ?? {}), ...headers },
        ...(payload !== undefined ? { payload: payload as never } : {}),
      }),
    close: async () => {
      await app.close();
      await area.close();
      await spacesArea.close();
      if (extraClose) await extraClose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
