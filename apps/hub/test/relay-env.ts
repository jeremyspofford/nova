// Shared setup for the Relay area's tests: a migrated database with the relay tables, settings
// read from the database (plus a managed layer), a real Relay service on 127.0.0.1, and the area
// on a Fastify app.
import type { FastifyRequest } from 'fastify';
import { NovaError, resolveSetting, type SettingKey } from '@nova/shared';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { buildRelayServer, type RelayServer, type RelayServerOptions } from '@nova/relay-service';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
export type WireJson = Record<string, any>;

export const ACCOUNT = '01920000-0000-7000-8000-0000000000f1';

export async function relayDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, iso, iso);
  return db;
}

/** `ctx.setting` over the database's global rows and a managed layer (docs/14 §1). */
export function dbSettings(db: NovaDatabase, managed: Record<string, unknown> = {}) {
  return <K extends SettingKey>(key: K) => {
    const rows = db.raw
      .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
      .all() as { key: string; value_json: string }[];
    const global: Record<string, unknown> = {};
    for (const r of rows) global[r.key] = JSON.parse(r.value_json) as unknown;
    return Promise.resolve(resolveSetting(key, { global, project: {}, managed }).value);
  };
}

export function putSetting(db: NovaDatabase, key: string, value: unknown): void {
  db.raw
    .prepare("DELETE FROM setting WHERE key = ? AND scope_kind = 'global' AND scope_ref = ''")
    .run(key);
  db.raw
    .prepare(
      "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', ?, ?)",
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}

export interface AreaCtx {
  ctx: HubContext;
  events: EventStore;
  secrets: MemorySecretStore;
  audit: AuditRecord[];
  logs: MemorySink;
  managed: Record<string, unknown>;
}

export function areaCtx(db: NovaDatabase): AreaCtx {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const logs = new MemorySink();
  const managed: Record<string, unknown> = {};
  const ctx = {
    config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
    db,
    log: new Logger({ module: 'hub', sinks: [logs] }),
    events,
    secrets,
    dataDir: '/nonexistent',
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: dbSettings(db, managed),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  return { ctx, events, secrets, audit: [], logs, managed };
}

export async function startRelay(
  opts: RelayServerOptions & { port?: number } = {},
): Promise<{ relay: RelayServer; url: string; port: number }> {
  const { port, ...rest } = opts;
  const relay = await buildRelayServer({
    log: new Logger({ module: 'relay', sinks: [] }),
    ...rest,
  });
  const address = await relay.app.listen({ host: '127.0.0.1', port: port ?? 0 });
  return { relay, url: address, port: Number(new URL(address).port) };
}

export async function until<T>(
  fn: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  ms = 10_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
