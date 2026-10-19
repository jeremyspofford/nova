// Shared setup for the boot area tests (FR-143, ADR-096 D5): a Hub with the devices, policy and
// boot areas, one enrolled fake device, the D5 fake novad behind its management channel, a Hub
// identity key that signs authorizations, and clocks the tests move. novad's heartbeat events
// reach the area the way the devices area passes them on.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { NovaError, SETTINGS, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import {
  FakeBootDevice,
  FakeDevice,
  type AuditRecord,
  type DeviceTransport,
  type NotificationInput,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupBoot, type BootArea } from '../src/boot.ts';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';
export const AUTH = { 'x-account': ACCOUNT };

export interface BootHub {
  dir: string;
  db: NovaDatabase;
  app: FastifyInstance;
  url: string;
  boot: BootArea;
  devices: DevicesArea;
  policy: PolicyAreaFull;
  diagnostics: DiagnosticsRegistry;
  settings: Partial<Record<SettingKey, unknown>>;
  audit: AuditRecord[];
  notes: NotificationInput[];
  clock: { now: number };
  /** How far the device's clock runs ahead of the Hub's (ms). */
  skew: { ms: number };
  device: FakeDevice;
  deviceId: string;
  fake: FakeBootDevice;
  api(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown>; headers: Record<string, unknown> }>;
  heartbeat(): Promise<void>;
  close(): Promise<void>;
}

/** A Hub with the devices, policy and boot areas, one enrolled device and its D5 fake. */
export async function bootHub(
  limits: { scriptsPerMinute?: number; imagesPerMinute?: number } = {},
): Promise<BootHub> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-boot-'));
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  const settings: Partial<Record<SettingKey, unknown>> = { 'devices.boot.allowLowLevel': true };
  const audit: AuditRecord[] = [];
  const notes: NotificationInput[] = [];
  const clock = { now: Date.now() };
  const skew = { ms: 0 };
  const diagnostics = new DiagnosticsRegistry();
  const events = new EventStore(db);
  const ctx = {
    config: {},
    db,
    secrets: new MemorySecretStore(),
    events,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    dataDir: join(dir, 'data'),
    diagnostics,
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
  } as unknown as HubContext;
  const sinks = {
    audit: { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n: NotificationInput) => (notes.push(n), Promise.resolve()) },
  };
  const policy = await setupPolicy({ ...ctx, ...sinks }, { home: join(dir, 'home') });
  const devices = await setupDevices(ctx, sinks);
  const keys = generateKeyPairSync('ed25519');
  const hubPublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  let fakeRef: FakeBootDevice | null = null;
  // The device's management channel: its boot routes are the D5 fake's.
  const transport: DeviceTransport = {
    post: (url, token, body, timeoutMs) => fakeRef!.transport().post(url, token, body, timeoutMs),
  };
  const now = () => new Date(clock.now);
  const boot = await setupBoot(ctx, {
    devices: devices.service,
    ...sinks,
    hubIdentity: () => ({ sign: (bytes) => sign(null, Buffer.from(bytes), keys.privateKey) }),
    transport,
    now,
    sweepIntervalMs: 3_600_000,
    limits,
  });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  policy.register(app);
  devices.register(app);
  boot.register(app);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  async function api(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = AUTH,
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
  }
  const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
  const device = new FakeDevice({ name: 'lab-box' });
  await device.enroll(url, t.json.token as string);
  const deviceId = device.deviceId!;
  const fake = new FakeBootDevice({
    hubPublicKey,
    deviceId,
    managementToken: device.managementToken,
    lowLevelBoot: true,
    now: () => new Date(clock.now + skew.ms),
  });
  fakeRef = fake;
  return {
    dir,
    db,
    app,
    url,
    boot,
    devices,
    policy,
    diagnostics,
    settings,
    audit,
    notes,
    clock,
    skew,
    device,
    deviceId,
    fake,
    api,
    async heartbeat() {
      const r = await device.heartbeat();
      if (r.status !== 200) throw new Error(`heartbeat ${r.status}`);
      await boot.heartbeatEvents(ACCOUNT, deviceId, fake.takeEvents());
    },
    async close() {
      await device.close();
      await boot.close();
      await devices.close();
      await policy.close();
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 5_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
