// The devices area on its own (FR-144, FR-148, FR-150): its late-bound audit and notifier, Wake-on-
// LAN to a UDP socket on loopback with the per-hour limit from settings, the node routes' novad
// hooks (Add Device for client roles, listing by role, revoking a novad device), the diagnostics
// probe and the Code environment it hands the code area.
import { createSocket } from 'node:dgram';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import {
  FakeDevice,
  NodeService,
  magicPacket,
  type AuditRecord,
  type NotificationInput,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { registerNodeRoutes } from '../src/node-routes.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';

let db: NovaDatabase;
let app: FastifyInstance;
let area: DevicesArea;
let url: string;
let audit: AuditRecord[];
let notes: NotificationInput[];
let diagnostics: DiagnosticsRegistry;
let udp: ReturnType<typeof createSocket>;
let packets: Buffer[];
let fakes: FakeDevice[];

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  udp = createSocket('udp4');
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  packets = [];
  udp.on('message', (m) => packets.push(m));
  audit = [];
  notes = [];
  diagnostics = new DiagnosticsRegistry();
  const settings: Partial<Record<SettingKey, unknown>> = {
    'devices.minNovadVersions': {},
    'devices.wakesPerHour': 1,
  };
  const secrets = new MemorySecretStore();
  const events = new EventStore(db);
  const ctx = {
    db,
    secrets,
    events,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting: (key: SettingKey) => Promise.resolve(settings[key]),
    accountOf: () => Promise.resolve(ACCOUNT),
  } as unknown as HubContext;
  area = await setupDevices(ctx, { wol: { address: '127.0.0.1', port: udp.address().port } });
  area.useAudit({ append: (r) => (audit.push(r), Promise.resolve()) });
  area.useNotifier({ notify: (n) => (notes.push(n), Promise.resolve()) });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  area.register(app);
  registerNodeRoutes(app, {
    nodes: new NodeService({ db, secrets, events }),
    accountOf: () => Promise.resolve(ACCOUNT),
    novad: area.nodeRoutes,
  });
  url = await app.listen({ port: 0, host: '127.0.0.1' });
  fakes = [];
});

afterEach(async () => {
  for (const f of fakes) await f.close();
  await area.close();
  await app.close();
  udp.close();
  db.close();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function enroll(opts: ConstructorParameters<typeof FakeDevice>[0] = {}): Promise<FakeDevice> {
  const t = await api('POST', '/api/v1/devices/add/start', { role: 'client' });
  expect(t.status).toBe(201);
  expect(t.json.token).toMatch(/^nvd_/);
  const fake = new FakeDevice(opts);
  fakes.push(fake);
  await fake.enroll(url, t.json.token as string);
  return fake;
}

describe('the devices area', () => {
  it('wakes over UDP, at most the configured times per hour, and audits it', async () => {
    const fake = await enroll({ wakeMac: '01:02:03:04:05:06' });
    const w = await api('POST', `/api/v1/devices/${fake.deviceId!}/wake`);
    expect(w.json).toMatchObject({ status: 'sent', mac: '01:02:03:04:05:06' });
    for (let i = 0; i < 50 && packets.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(packets[0]?.equals(magicPacket('01:02:03:04:05:06'))).toBe(true);
    const again = await api('POST', `/api/v1/devices/${fake.deviceId!}/wake`);
    expect(again.status).toBe(429);
    expect(audit.filter((a) => a.action === 'device.wake').map((a) => a.detail?.status)).toEqual([
      'sent',
      'rate_limited',
    ]);
    expect(audit.every((a) => a.kind === 'device')).toBe(true);
  });

  it('lists and revokes novad devices through the node routes', async () => {
    const fake = await enroll();
    const list = await api('GET', '/api/v1/devices?role=client');
    expect((list.json.items as { id: string }[]).map((d) => d.id)).toEqual([fake.deviceId]);
    expect((await api('GET', '/api/v1/devices?role=wake-helper')).json.items).toEqual([]);
    expect((await api('GET', '/api/v1/devices')).json.items).toEqual([]);
    expect((await api('POST', `/api/v1/devices/${fake.deviceId!}/revoke`)).json.ok).toBe(true);
    expect((await fake.heartbeat()).status).toBe(401);
    expect(
      (await api('POST', '/api/v1/devices/01920000-0000-7000-8000-00000000ffff/revoke')).status,
    ).toBe(404);
    expect(await diagnostics.collect()).toMatchObject({ devices: { revoked: 1 } });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['device.register', 'device.revoke']),
    );
  });

  it('notifies about folder requests and hands out device environments', async () => {
    const fake = await enroll();
    const r = await api('POST', `/api/v1/devices/${fake.deviceId!}/access-requests`, {
      path: '/tmp',
      access: 'read',
      grantee: { kind: 'session', id: 's1' },
    });
    expect(r.json.status).toBe('pending');
    expect(notes[0]).toMatchObject({ kind: 'approval', title: 'Folder access requested' });
    const env = area.environment({ accountId: ACCOUNT, deviceId: fake.deviceId!, sessionId: 's1' });
    expect((await env.health()).status).toBe('ok');
    expect(env.computer.kind).toBe('local_host');
    // Device-side approval reaches the Hub with the next heartbeat.
    fake.decideLocally(fake.requests[0]!.id, true);
    await fake.heartbeat();
    expect(
      (await api('GET', `/api/v1/devices/${fake.deviceId!}/access-requests/${r.json.id as string}`))
        .json.status,
    ).toBe('granted');
    expect((await env.computer.fs.list('/tmp')).length).toBeGreaterThanOrEqual(0);
    expect(
      (await api('GET', `/api/v1/devices/other/access-requests/${r.json.id as string}`)).status,
    ).toBe(404);
  });

  it('registers a local_host computer with the computers area when an agent connects', async () => {
    const fake = await enroll();
    const ensured: unknown[] = [];
    area.useComputers({
      ensureLocalHost: (accountId, input) => (
        ensured.push({ accountId, ...input }),
        Promise.resolve()
      ),
    });
    const c = await api('POST', '/api/v1/devices/connections', {
      agentId: 'ag',
      deviceId: fake.deviceId!,
    });
    expect(c.status).toBe(201);
    expect(ensured).toEqual([{ accountId: ACCOUNT, deviceId: fake.deviceId, agentId: 'ag' }]);
    const computer = await area.computers.forAgent(ACCOUNT, 'ag');
    expect(computer.kind).toBe('local_host');
  });

  it('validates the novad routes', async () => {
    expect((await api('POST', '/agent/v1/register', { enrollToken: 'x' })).status).toBe(400);
    expect((await api('POST', '/agent/v1/capabilities', {})).status).toBe(401);
    expect((await api('POST', '/api/v1/devices/novad/enroll', { roles: ['root'] })).status).toBe(
      400,
    );
    const e = await api('POST', '/api/v1/devices/novad/enroll', {});
    expect(e.status).toBe(201);
    expect(e.json.command).toMatch(/^novad enroll --hub http:\/\/127\.0\.0\.1:\d+ --token nvd_/);
    expect(new NovaError('validation', 'x').code).toBe('validation');
  });
});
