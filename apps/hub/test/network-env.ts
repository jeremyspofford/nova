// Shared setup for the network area's tests: a migrated database with the network tables, a
// settings map behind ctx.setting and a writer like PATCH /api/v1/settings, fake interfaces, a
// fake probe and a fake mDNS responder, and the area's routes on a Fastify app on 127.0.0.1:0.
import { EventEmitter } from 'node:events';
import type { NetworkInterfaceInfo } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  NovaError,
  checkSettingWrite,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type EndpointProbeOutcome,
  type SettingKey,
} from '@nova/shared';
import type {
  AuditRecord,
  HelloProbeOptions,
  HelloProbeResult,
  MdnsRecord,
  MdnsResponder,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupNetwork, type NetworkArea, type NetworkDeps } from '../src/network.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';

export async function networkDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  return db;
}

export function iface(address: string, prefix: number, internal = false): NetworkInterfaceInfo {
  const v6 = address.includes(':');
  return {
    address,
    netmask: v6 ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
    family: v6 ? 'IPv6' : 'IPv4',
    mac: '02:00:00:00:00:01',
    internal,
    cidr: `${address}/${prefix}`,
    ...(v6 ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

export class FakeProbe {
  readonly answers = new Map<string, EndpointProbeOutcome>();
  readonly calls: { url: string; opts: HelloProbeOptions }[] = [];
  /** How long each probe takes (real time). */
  delayMs = 0;
  set(url: string, ok: boolean, latencyMs = 5): void {
    this.answers.set(url, { ok, latencyMs: ok ? latencyMs : null });
  }
  readonly probe = async (url: string, opts: HelloProbeOptions): Promise<HelloProbeResult> => {
    this.calls.push({ url, opts });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const a = this.answers.get(url);
    return a?.ok
      ? { ok: true, latencyMs: a.latencyMs ?? null, detail: null }
      : { ok: false, latencyMs: null, detail: 'connection refused' };
  };
}

export class FakeResponder extends EventEmitter implements MdnsResponder {
  readonly sent: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }[] = [];
  destroyed = false;
  respond(packet: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }): void {
    this.sent.push(packet);
  }
  destroy(cb?: () => void): void {
    this.destroyed = true;
    cb?.();
  }
}

/** One JSON request to the test app (the body comes back untyped, as in the other Hub tests). */
async function call(url: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

export interface NetworkEnv {
  db: NovaDatabase;
  ctx: HubContext;
  events: EventStore;
  secrets: MemorySecretStore;
  settings: Map<string, unknown>;
  audit: AuditRecord[];
  diagnostics: DiagnosticsRegistry;
  probe: FakeProbe;
  responders: FakeResponder[];
  area: NetworkArea;
  app: FastifyInstance;
  url: string;
  api(method: string, path: string, body?: unknown): ReturnType<typeof call>;
  close(): Promise<void>;
}

/** The area on its own Fastify app; `extra` registers other routes first (another area). */
export async function networkEnv(
  opts: {
    deps?: NetworkDeps;
    interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
    db?: NovaDatabase;
    settings?: Record<string, unknown>;
    writer?: boolean;
    extra?: (ctx: HubContext, app: FastifyInstance) => Promise<{ close(): Promise<void> }>;
  } = {},
): Promise<NetworkEnv> {
  const db = opts.db ?? (await networkDb());
  const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const audit: AuditRecord[] = [];
  const diagnostics = new DiagnosticsRegistry();
  const ctx = {
    db,
    secrets,
    events,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting: (key: SettingKey) =>
      Promise.resolve(resolveSetting(key, { global: Object.fromEntries(settings) }).value),
    accountOf: () => Promise.resolve(ACCOUNT),
  } as unknown as HubContext;
  const probe = new FakeProbe();
  const responders: FakeResponder[] = [];
  const area = await setupNetwork(ctx, {
    probe: probe.probe,
    interfaces: opts.interfaces ?? (() => ({ eth0: [iface('192.168.1.10', 24)] })),
    hostname: () => 'Study-PC',
    mdns: () => {
      const r = new FakeResponder();
      responders.push(r);
      return r;
    },
    timers: { setInterval: () => 0, clearInterval: () => undefined },
    ...opts.deps,
  });
  area.useAudit({ append: (r) => (audit.push(r), Promise.resolve()) });
  if (opts.writer !== false) {
    area.useSettingsWriter(async (_accountId, key, value) => {
      const check = checkSettingWrite(key, value, 'global', {
        global: Object.fromEntries(settings),
      });
      if (!check.ok) throw new NovaError('validation', check.message);
      settings.set(key, check.value);
      await events.emit({ name: 'settings.changed', actor: 'user', payload: { key } });
    });
  }
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply
      .status((err as { statusCode?: number }).statusCode ?? 400)
      .send({ error: { code: 'validation', message: String(err) } });
  });
  const other = opts.extra ? await opts.extra(ctx, app) : null;
  area.register(app);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    db,
    ctx,
    events,
    secrets,
    settings,
    audit,
    diagnostics,
    probe,
    responders,
    area,
    app,
    url,
    api: (method, path, body) => call(url, method, path, body),
    async close() {
      await other?.close();
      await area.close();
      await app.close();
      db.close();
    },
  };
}
