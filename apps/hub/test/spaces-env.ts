// A Fastify app with only the spaces area (FR-036, FR-037, FR-076) over a migrated in-memory
// database, an account check by header, the Hub's error mapping, collected audit records and a
// temporary data folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type LightMyRequestResponse,
} from 'fastify';
import { z } from 'zod';
import { NovaError, SETTINGS, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupSpaces, type SpacesArea } from '../src/spaces.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000000e1';
export const OTHER = '01920000-0000-7000-8000-0000000000e2';
export const AUTH = { 'x-account': ACCOUNT };
export const AUTH_OTHER = { 'x-account': OTHER };

export interface SpacesHub {
  app: FastifyInstance;
  area: SpacesArea;
  db: NovaDatabase;
  events: EventStore;
  audit: AuditRecord[];
  diagnostics: DiagnosticsRegistry;
  dir: string;
  dataDir: string;
  settings: Partial<Record<SettingKey, unknown>>;
  call: (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function spacesHub(): Promise<SpacesHub> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, now, now);
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-spaces-'));
  const dataDir = join(dir, 'data');
  const events = new EventStore(db);
  const audit: AuditRecord[] = [];
  const diagnostics = new DiagnosticsRegistry();
  const settings: Partial<Record<SettingKey, unknown>> = {};
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
    dataDir,
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) =>
      Promise.resolve((key in settings ? settings[key] : SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      const a = req.headers['x-account'];
      if (a !== ACCOUNT && a !== OTHER)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(a);
    },
    diagnostics,
  } as unknown as Parameters<typeof setupSpaces>[0];
  const area = await setupSpaces(ctx);
  area.useAudit({ append: (r) => Promise.resolve(void audit.push(r)) });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return {
    app,
    area,
    db,
    events,
    audit,
    diagnostics,
    dir,
    dataDir,
    settings,
    call: (method, url, payload, headers = AUTH) =>
      app.inject({
        method,
        url,
        headers,
        ...(payload !== undefined ? { payload: payload as never } : {}),
      }),
    close: async () => {
      await area.close();
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
