// M7.5 device operations through the Hub's routes (ADR-096 D1, D3, D9; FR-126, FR-142, FR-145,
// FR-148, FR-150): the management channel over mutual TLS with the trust area's client
// certificate and its diagnostics, the heartbeat answer's device policy, decommission through the
// approval card (online and offline), the routes the M6 UI lacked (managed services, available
// updates, owner overrides), and a real compute node's policy, VRAM and services.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import { FakeDevice, NodeService, TrustService, rawEd25519, type AuditRecord } from '@nova/core';
import {
  ComputeNode,
  enroll as enrollNode,
  fakeUnitController,
  fakeVramProbe,
  startFakeBackend,
  type FakeBackend,
} from '@nova/compute';
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
let diagnostics: DiagnosticsRegistry;
let events: EventStore;
let trust: TrustService;
let nodes: NodeService;
let fakes: FakeDevice[];
let hubKey: { sign: (b: Uint8Array | string) => Buffer; publicKey: string };

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  audit = [];
  diagnostics = new DiagnosticsRegistry();
  const settings: Partial<Record<SettingKey, unknown>> = {
    'devices.minNovadVersions': {},
    'devices.wakesPerHour': 6,
  };
  const secrets = new MemorySecretStore();
  events = new EventStore(db);
  const ctx = {
    db,
    secrets,
    events,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting: (key: SettingKey) => Promise.resolve(settings[key]),
    accountOf: () => Promise.resolve(ACCOUNT),
  } as unknown as HubContext;
  area = await setupDevices(ctx);
  area.useAudit({ append: (r) => (audit.push(r), Promise.resolve()) });
  trust = new TrustService({
    db,
    secrets,
    settings: {
      mode: () => Promise.resolve('local-ca'),
      meshCerts: () => Promise.resolve(false),
      pinNativeShells: () => Promise.resolve(true),
    },
    names: () => Promise.resolve(['nova-hub.local']),
    ownerAccount: () => Promise.resolve(ACCOUNT),
  });
  await trust.start();
  await trust.ensureCa();
  // The wiring app.ts adds (ADR-096 D1, D2).
  area.useManagementTls({
    material: () => trust.hubClientCertificate(),
    verifyDeviceCertificate: (pem) => trust.verifyDeviceCertificate(pem),
    allowLegacyServerCertificate: (id, pem) => trust.legacyServerCertificateAllowed(id, pem),
    presented: (id, serial) => trust.deviceCertificatePresented(id, serial),
    certificateState: (id) => trust.deviceCertificateState(id),
  });
  area.useCertificateRenewal((id, key) => trust.deviceCertificateRenewal(id, key));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  hubKey = {
    sign: (b) => sign(null, typeof b === 'string' ? Buffer.from(b) : Buffer.from(b), privateKey),
    publicKey: rawEd25519(publicKey).toString('base64url'),
  };
  area.useAuthzSigner(hubKey);
  nodes = new NodeService({ db, secrets, events });
  nodes.useAudit({ append: (r) => (audit.push(r), Promise.resolve()) });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  area.register(app);
  registerNodeRoutes(app, {
    nodes,
    accountOf: () => Promise.resolve(ACCOUNT),
    novad: area.nodeRoutes,
  });
  url = await app.listen({ port: 0, host: '127.0.0.1' });
  fakes = [];
});

afterEach(async () => {
  for (const f of fakes) await f.close();
  nodes.stop();
  await area.close();
  await app.close();
  db.close();
});

async function api(method: string, path: string, body?: unknown, auth?: string) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, json };
}

async function enroll(opts: ConstructorParameters<typeof FakeDevice>[0] = {}): Promise<FakeDevice> {
  const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
  const fake = new FakeDevice({ hubKey: hubKey.publicKey, ...opts });
  fakes.push(fake);
  await fake.enroll(url, t.json.token as string);
  return fake;
}

/** The device gets its certificate, serves HTTPS and reports the endpoint (D1). */
async function toHttps(fake: FakeDevice): Promise<string> {
  const cert = await trust.issueDeviceCertificate({
    deviceId: fake.deviceId!,
    publicKey: fake.publicKey,
    role: 'client',
  });
  const endpoint = await fake.listenTls({
    certPem: cert!.certificatePem,
    caPem: trust.caCertificate()!,
  });
  expect((await fake.heartbeat({ endpoint })).status).toBe(200);
  return endpoint;
}

/** What the approvals route does when the owner answers a card. */
async function decide(approvalId: string, decision: string): Promise<void> {
  db.raw
    .prepare(
      "UPDATE approval SET status = 'decided', decision = ?, decided_by = 'user', decided_at = ? WHERE id = ?",
    )
    .run(decision, new Date().toISOString(), approvalId);
  await events.emit({
    name: 'approval.decided',
    accountId: ACCOUNT,
    actor: 'user',
    payload: { approvalId, decision, decidedBy: 'user', override: false },
  });
}

async function until(fn: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('the management channel over mutual TLS (D1)', () => {
  it('manages an https device over mutual TLS and shows it in the routes and diagnostics', async () => {
    const fake = await enroll({ modules: ['management', 'storage', 'compute'] });
    let tls = await api('GET', '/api/v1/devices/management-tls');
    expect(tls.json.items[0]).toMatchObject({
      deviceId: fake.deviceId,
      channel: 'plain_http',
      renewal: null,
      legacyCertificate: false,
      legacyGraceEndsAt: null,
    });
    expect(tls.json.problems.join(' ')).toContain('plain HTTP');
    const endpoint = await toHttps(fake);
    const services = await api('GET', `/api/v1/devices/${fake.deviceId!}/services`);
    expect(services.status).toBe(200);
    expect(services.json.items).toEqual([
      { name: 'compute', kind: 'module', state: 'running', module: 'compute', unit: null },
    ]);
    tls = await api('GET', '/api/v1/devices/management-tls');
    expect(tls.json.items[0]).toMatchObject({
      endpoint,
      channel: 'mutual_tls',
      lastCall: { ok: true },
      renewal: { state: 'none', offeredAt: null, notAfter: null, reason: null },
      legacyCertificate: false,
    });
    expect(tls.json.hubClient.uri).toMatch(/^urn:nova:hub:/);
    const diag = (await diagnostics.collect()) as {
      deviceManagement: { mutualTls: string[]; plainHttp: string[]; problems: string[] };
    };
    expect(diag.deviceManagement).toMatchObject({ mutualTls: [fake.name], plainHttp: [] });
    // An https device offering plain HTTP is refused, and stays on https.
    const down = await api(
      'POST',
      '/agent/v1/heartbeat',
      { novadVersion: '0.6.0', endpoint: 'http://127.0.0.1:7420' },
      fake.credential!,
    );
    expect(down.status).toBe(403);
    expect(down.json.error.details).toEqual({ reason: 'endpoint_downgrade' });
    expect((await api('GET', `/api/v1/devices/${fake.deviceId!}`)).json.endpoint).toBe(endpoint);
  });

  it('refuses a device certificate naming another device', async () => {
    const fake = await enroll();
    await toHttps(fake);
    const other = await trust.issueDeviceCertificate({
      deviceId: 'another-device',
      publicKey: fake.publicKey,
      role: 'client',
    });
    const endpoint = await fake.listenTls({
      certPem: other!.certificatePem,
      caPem: trust.caCertificate()!,
    });
    await fake.heartbeat({ endpoint });
    const r = await api('GET', `/api/v1/devices/${fake.deviceId!}/power`);
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ reason: 'device_tls_failed', tls: 'wrong_device' });
    const diag = (await diagnostics.collect()) as {
      deviceManagement: { mutualTls: string[]; plainHttp: string[]; problems: string[] };
    };
    expect(diag.deviceManagement.problems.join(' ')).toContain('wrong_device');
  });
});

describe('the heartbeat answer (D3)', () => {
  it('carries the firmware and boot areas’ answers, false by default', async () => {
    const fake = await enroll();
    expect((await fake.heartbeat()).json.policy).toEqual({
      firmwareChanges: false,
      lowLevelBoot: false,
    });
    area.useFirmwarePolicy(() => Promise.resolve(true));
    area.useBootPolicy(() => Promise.resolve(true));
    expect((await fake.heartbeat()).json.policy).toEqual({
      firmwareChanges: true,
      lowLevelBoot: true,
    });
  });
});

describe('decommission (D9)', () => {
  it('waits for the approval card, tells the device and revokes it', async () => {
    const fake = await enroll();
    const r = await api('POST', `/api/v1/devices/${fake.deviceId!}/decommission`, { purge: true });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: 'awaiting_approval', purge: true });
    expect((await api('POST', `/api/v1/devices/${fake.deviceId!}/decommission`, {})).status).toBe(
      409,
    );
    expect(
      (await api('POST', `/api/v1/devices/${fake.deviceId!}/decommission`, { wipe: 1 })).status,
    ).toBe(400);
    await decide(r.json.approvalId as string, 'allow_once');
    await until(
      async () =>
        (await api('GET', `/api/v1/devices/${fake.deviceId!}/decommission`)).json.decommission
          ?.status === 'done',
    );
    const view = await api('GET', `/api/v1/devices/${fake.deviceId!}/decommission`);
    expect(view.json.decommission).toMatchObject({ deviceResult: 'wiped', purge: true });
    expect(fake.decommissioned).toEqual({ purge: true });
    expect((await api('GET', `/api/v1/devices/${fake.deviceId!}`)).json.status).toBe('revoked');
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'device.decommission.request',
        'device.decommission',
        'device.revoke',
      ]),
    );
  });

  it('revokes an offline device at once', async () => {
    const fake = await enroll();
    await fake.close();
    db.raw.prepare("UPDATE device SET status = 'unreachable' WHERE id = ?").run(fake.deviceId);
    const r = await api('POST', `/api/v1/devices/${fake.deviceId!}/decommission`, {});
    await decide(r.json.approvalId as string, 'allow_once');
    await until(
      async () =>
        (await api('GET', `/api/v1/devices/${fake.deviceId!}/decommission`)).json.decommission
          ?.status === 'done',
    );
    expect(
      (await api('GET', `/api/v1/devices/${fake.deviceId!}/decommission`)).json.decommission
        .deviceResult,
    ).toBe('unreachable');
    expect((await fake.heartbeat()).status).toBe(401);
  });

  it('does nothing when the owner denies it', async () => {
    const fake = await enroll();
    const r = await api('POST', `/api/v1/devices/${fake.deviceId!}/decommission`, {});
    await decide(r.json.approvalId as string, 'deny_continue');
    await until(
      async () =>
        (await api('GET', `/api/v1/devices/${fake.deviceId!}/decommission`)).json.decommission
          ?.status === 'denied',
    );
    expect((await api('GET', `/api/v1/devices/${fake.deviceId!}`)).json.status).toBe('active');
    expect(fake.decommissioned).toBeNull();
  });
});

describe('available updates and owner overrides', () => {
  it('compares with the agent-dist builds and shows and pushes the overrides', async () => {
    const fake = await enroll({ novadVersion: '0.6.0' });
    let u = await api('GET', `/api/v1/devices/${fake.deviceId!}/updates/available`);
    expect(u.json).toMatchObject({ newer: false, reason: 'no_builds' });
    area.useAvailableBuilds(() =>
      Promise.resolve({
        version: '0.8.0',
        files: [
          {
            name: 'novad-linux-amd64',
            os: 'linux',
            arch: 'amd64',
            sha256: 'a'.repeat(64),
            size: 1,
          },
        ],
      }),
    );
    u = await api('GET', `/api/v1/devices/${fake.deviceId!}/updates/available`);
    expect(u.json).toMatchObject({ newer: true, novad: { version: '0.8.0' } });

    await api('PATCH', `/api/v1/devices/${fake.deviceId!}`, {
      policy: { quietHours: ['23:00-06:00'] },
    });
    const o = await api('GET', `/api/v1/devices/${fake.deviceId!}/overrides`);
    expect(o.json).toMatchObject({ policy: { quietHours: ['23:00-06:00'] }, configPending: false });
    const p = await api('POST', `/api/v1/devices/${fake.deviceId!}/overrides/push`);
    expect(p.status).toBe(200);
    expect(p.json.pushedRevision).toBe(p.json.configRevision);
    expect(fake.hubConfig.policy).toMatchObject({ quietHours: ['23:00-06:00'] });
    expect(audit.map((a) => a.action)).toContain('device.config.push');
    expect((await api('GET', '/api/v1/devices/nope/overrides')).status).toBe(404);
  });
});

describe('a compute node (FR-126 leftovers)', () => {
  let dir: string;
  let backend: FakeBackend;
  let node: ComputeNode | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-hub-node-m75-'));
    backend = await startFakeBackend({ models: ['llama3'] });
    node = null;
  });

  afterEach(async () => {
    await node?.stop();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the owner’s policy with its heartbeat, reports VRAM and serves its services', async () => {
    const t = await api('POST', '/api/v1/devices/compute/enroll');
    const vram = fakeVramProbe([
      { index: 0, vendor: 'nvidia', name: 'RTX', totalBytes: 8 * 1024 ** 3, usedBytes: 1024 },
    ]);
    await enrollNode({
      hubUrl: url,
      token: t.json.token as string,
      backendUrl: backend.url,
      backendKind: 'llamacpp',
      name: 'gpu',
      listen: '127.0.0.1:0',
      advertise: 'http://127.0.0.1:1',
      dataDir: dir,
      vram,
      backendUnit: 'llama.service',
    });
    const units = fakeUnitController({ 'llama.service': 'running' });
    node = await ComputeNode.start({
      dataDir: dir,
      listen: { host: '127.0.0.1', port: 0 },
      heartbeatIntervalMs: 60_000,
      log: new Logger({ module: 'node', sinks: [new MemorySink()] }),
      vram,
      units,
      timeZone: 'UTC',
    });
    const id = node.nodeId!;
    // The Hub calls the node where it listens now.
    db.raw.prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?').run(node.url, id);
    await node.beat();
    let d = await api('GET', `/api/v1/devices/${id}/node`);
    expect(d.json).toMatchObject({
      status: 'active',
      quietNow: false,
      reportedQuiet: false,
      vram: [{ index: 0, totalBytes: 8 * 1024 ** 3 }],
      policy: { revision: 0 },
    });
    // Quiet all day long: the node takes it with its next heartbeat and refuses new jobs.
    const put = await api('PUT', `/api/v1/devices/${id}/node/policy`, {
      quietHours: ['00:00-23:59'],
    });
    expect(put.json).toMatchObject({ quietHours: ['00:00-23:59'], revision: 1 });
    expect(
      (await api('PUT', `/api/v1/devices/${id}/node/policy`, { quietHours: ['x'] })).status,
    ).toBe(400);
    await node.beat();
    expect(node.hubPolicy?.revision).toBe(1);
    await node.beat();
    d = await api('GET', `/api/v1/devices/${id}/node`);
    expect(d.json).toMatchObject({ quietNow: true, reportedQuiet: true });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
    // The node's services, through the Hub, with its job token.
    const s = await api('GET', `/api/v1/devices/${id}/node/services`);
    expect(s.json.items).toEqual([
      { name: 'jobs', kind: 'builtin', state: 'running', unit: null },
      { name: 'backend', kind: 'systemd', state: 'running', unit: 'llama.service' },
    ]);
    const stop = await api('POST', `/api/v1/devices/${id}/node/services/backend/stop`);
    expect(stop.json.service).toMatchObject({ name: 'backend', state: 'stopped' });
    expect(units.calls).toEqual(['stop llama.service']);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['node.policy.update', 'node.service.stop']),
    );
    expect((await api('POST', `/api/v1/devices/${id}/node/services/backend/kill`)).status).toBe(
      400,
    );
  });

  it('refuses an unknown node', async () => {
    const r = await api('GET', '/api/v1/devices/01920000-0000-7000-8000-00000000ffff/node');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe(new NovaError('not_found', 'x').code);
  });
});
