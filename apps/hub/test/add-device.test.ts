// The Add Device area over HTTP (FR-132, FR-140; docs/22 §4, §9): the whole flow with a generated
// Ed25519 key for a browser (a device session and its cookie), for novad (continuing into the real
// `/agent/v1/register` with the granted token) and for a compute node (the real `nova-compute`
// join path into `/node/v1/register`); owner routes need a session, the public ones authenticate
// by the code or the device key and are rate-limited per address; the seams (bootstrap, endpoints,
// Hub identity, Relay); revocation deletes sessions and blocks keys; nothing secret is logged.
import { generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import {
  FakeDevice,
  NodeService,
  canonicalJson,
  hubRevealStatement,
  pairingCommitment,
  pairingConfirmationV2,
  pairingRevealMessage,
  pairingStatusMessage,
  type AuditRecord,
} from '@nova/core';
import { joinWithCode, startFakeBackend, type FakeBackend } from '@nova/compute';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  addDeviceLinks,
  setupAddDevice,
  type AddDeviceArea,
  type AddDeviceDeps,
} from '../src/add-device.ts';
import { AuthService } from '../src/auth.ts';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { registerNodeRoutes } from '../src/node-routes.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OWNER = { 'x-test-owner': '1' };

let db: NovaDatabase;
let events: EventStore;
let nodes: NodeService;
let devices: DevicesArea;
let area: AddDeviceArea;
let app: FastifyInstance;
let url: string;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let dir: string;

async function build(limits?: AddDeviceDeps['limits']): Promise<void> {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  settings = {
    'devices.add.enabled': true,
    'devices.add.sessionDays': 30,
    'devices.minNovadVersions': {},
    'devices.wakesPerHour': 6,
  };
  const secrets = new MemorySecretStore();
  events = new EventStore(db);
  nodes = new NodeService({ db, secrets, events });
  audit = [];
  // Owner routes take the account from a test header; anything else has no session.
  const accountOf = (req: FastifyRequest) => {
    if (req.headers['x-test-owner'] !== '1')
      return Promise.reject(new NovaError('token_required', 'sign in'));
    return Promise.resolve(ACCOUNT);
  };
  const ctx = {
    db,
    secrets,
    events,
    nodes,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics: new DiagnosticsRegistry(),
    setting: (key: SettingKey) => Promise.resolve(settings[key]),
    accountOf,
  } as unknown as HubContext;
  devices = await setupDevices(ctx);
  area = await setupAddDevice(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    ...(limits ? { limits } : {}),
  });
  area.useDevices(devices.service);
  app = Fastify();
  await app.register(fastifyCookie);
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  devices.register(app);
  area.register(app);
  registerNodeRoutes(app, { nodes, accountOf, novad: devices.nodeRoutes, added: area.revoker });
  // The Hub's public hello (app.ts); a joining node reads the identity fingerprint from it.
  app.get('/api/v1/hello', () => ({ name: 'nova-hub' }));
  url = await app.listen({ port: 0, host: '127.0.0.1' });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-add-device-'));
  offset = 0;
  await build();
});

afterEach(async () => {
  await area.close();
  await devices.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = OWNER,
) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

interface Key {
  publicKey: string;
  privateKey: KeyObject;
}

function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: (publicKey.export({ format: 'jwk' }) as { x: string }).x, privateKey };
}

/** The new device's signed status poll; `offset` keeps each poll's time newer than the last. */
let offset = 0;
async function poll(key: Key, requestId: string) {
  const time = Math.floor(Date.now() / 1000) + offset++;
  const signature = sign(null, pairingStatusMessage(requestId, time), key.privateKey).toString(
    'base64url',
  );
  return api('GET', `/api/v1/devices/add/status/${requestId}`, undefined, {
    'x-nova-device-time': String(time),
    'x-nova-device-signature': signature,
  });
}

async function start(body: Record<string, unknown>) {
  const s = await api('POST', '/api/v1/devices/add/start', body);
  expect(s.status).toBe(201);
  return s.json as {
    pairingId: string;
    code: string;
    qr: string;
    deepLink: string;
    pageUrl: string;
    bootstrap: { command: string | null; why: string | null };
    hubFingerprint: string | null;
    endpoints: string[];
    relay: unknown;
    expiresAt: string;
  };
}

/** The device's signed reveal of its nonce (Add Device v2). */
async function reveal(key: Key, requestId: string, nonce: string, signer: Key = key) {
  const time = Math.floor(Date.now() / 1000);
  const signature = sign(null, pairingRevealMessage(requestId, time), signer.privateKey).toString(
    'base64url',
  );
  return api(
    'POST',
    '/api/v1/devices/add/reveal',
    { requestId, nonce },
    {
      'x-nova-device-time': String(time),
      'x-nova-device-signature': signature,
    },
  );
}

/** Commit (`add/complete` with a commitment), then reveal, as a joining device does. */
async function commit(
  started: { pairingId?: string; code: string },
  key: Key,
  kind: string,
  extra: Record<string, unknown> = {},
  deviceNonce = randomBytes(32).toString('base64url'),
) {
  return api(
    'POST',
    '/api/v1/devices/add/complete',
    {
      ...(started.pairingId ? { pairingId: started.pairingId } : {}),
      code: started.code,
      publicKey: key.publicKey,
      name: 'device',
      platform: 'linux',
      kind,
      commitment: pairingCommitment(key.publicKey, deviceNonce),
      ...extra,
    },
    {},
  );
}

async function complete(
  started: { pairingId: string; code: string },
  key: Key,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  const deviceNonce = randomBytes(32).toString('base64url');
  const c = await commit(started, key, kind, extra, deviceNonce);
  if (c.status !== 202) return { ...c, committed: null, deviceNonce };
  const r = await reveal(key, c.json.requestId as string, deviceNonce);
  return {
    ...r,
    committed: c.json as { requestId: string; pairingId: string; hubNonce: string },
    deviceNonce,
    json: { ...r.json, pairingId: c.json.pairingId },
  };
}

describe('owner routes', () => {
  it('need a session; the public ones authenticate by code or key', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/devices/add/start'],
      ['GET', '/api/v1/devices/add/requests'],
      ['POST', '/api/v1/devices/add/requests/x/approve'],
      ['POST', '/api/v1/devices/add/requests/x/deny'],
      ['GET', '/api/v1/devices/all'],
      ['PUT', '/api/v1/devices/x/scopes'],
      ['POST', '/api/v1/devices/compute/enroll'],
    ] as const) {
      const r = await api(method, path, method === 'GET' ? undefined : {}, {});
      expect(r.status, path).toBe(401);
      expect(r.json.error.code, path).toBe('token_required');
    }
    const c = await api('POST', '/api/v1/devices/add/complete', {}, {});
    expect(c.status).toBe(400);
    const s = await api('GET', '/api/v1/devices/add/status/x', undefined, {});
    expect(s.status).toBe(401);
    expect(s.json.error.details).toEqual({ reason: 'missing_proof' });
    expect((await api('POST', '/api/v1/devices/add/start', { role: 'toaster' })).status).toBe(400);
  });

  it('keep the scripted compute token path', async () => {
    const t = await api('POST', '/api/v1/devices/compute/enroll');
    expect(t.status).toBe(201);
    expect(t.json.token).toMatch(/^nve_/);
  });

  it('refuse a start while Add Device is off', async () => {
    settings['devices.add.enabled'] = false;
    const r = await api('POST', '/api/v1/devices/add/start', { role: 'client' });
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ reason: 'add_device_disabled' });
  });
});

describe('a browser joins', () => {
  it('with a code, a confirmation, approval, a session cookie and revocation', async () => {
    const started = await start({ role: 'client', scopes: ['offline-replica'], name: 'Phone' });
    expect(started.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(started.qr).toBe(`${url}/add-device?p=${started.pairingId}#c=${started.code}`);
    expect(started.deepLink).toBe(
      `nova://add-device?h=${encodeURIComponent(url)}&p=${started.pairingId}#c=${started.code}`,
    );
    expect(started.pageUrl).toBe(`${url}/add-device?p=${started.pairingId}`);
    expect(started.hubFingerprint).toBeNull();
    expect(started.endpoints).toEqual([]);
    expect(started.relay).toBeNull();
    expect(started.bootstrap.command).toBeNull();
    expect(started.bootstrap.why).toMatch(/no novad build/);

    const key = newKey();
    const done = await complete(started, key, 'browser');
    expect(done.status).toBe(200);
    expect(done.committed).toMatchObject({ pairingId: started.pairingId, status: 'committed' });
    // The device computes the confirmation on its own and gets the Hub's number.
    expect(done.json).toMatchObject({
      pairingId: started.pairingId,
      status: 'pending',
      hubSignature: null,
      confirmation: pairingConfirmationV2({
        hubFingerprint: '',
        pairingId: started.pairingId,
        publicKey: key.publicKey,
        code: started.code,
        deviceNonce: done.deviceNonce,
        hubNonce: done.committed!.hubNonce,
      }),
    });
    const requestId = done.json.requestId as string;
    expect((await poll(key, requestId)).json).toEqual({ status: 'pending' });

    const list = await api('GET', '/api/v1/devices/add/requests');
    expect(list.json.items).toEqual([
      expect.objectContaining({
        id: requestId,
        name: 'Phone',
        platform: 'linux',
        role: 'client',
        kind: 'browser',
        confirmation: done.json.confirmation,
        scopes: ['offline-replica'],
      }),
    ]);
    const wrong = await api('POST', `/api/v1/devices/add/requests/${requestId}/approve`, {
      confirmation: done.json.confirmation === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.details.reason).toBe('confirmation_mismatch');
    const approved = await api('POST', `/api/v1/devices/add/requests/${requestId}/approve`, {
      confirmation: done.json.confirmation,
    });
    expect(approved.json).toMatchObject({ status: 'approved' });
    const deviceId = approved.json.deviceId as string;

    const granted = await poll(key, requestId);
    expect(granted.headers.get('cache-control')).toBe('no-store');
    expect(granted.json.status).toBe('approved');
    expect(granted.json.grant.type).toBe('session');
    const token = granted.json.grant.token as string;
    const cookie = granted.headers.getSetCookie().find((c) => c.startsWith('nova_session='));
    expect(cookie).toContain(`nova_session=${token}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    // The Hub's own session check accepts it.
    const auth = new AuthService(db);
    expect(await auth.verify(token)).toMatchObject({ kind: 'session', accountId: ACCOUNT });
    expect((await poll(key, requestId)).json).toEqual({ status: 'approved', deviceId });

    const all = await api('GET', '/api/v1/devices/all');
    expect(all.json.items).toEqual([
      expect.objectContaining({ id: deviceId, addedAs: 'browser', sessions: 1, status: 'active' }),
    ]);
    const scoped = await api('PUT', `/api/v1/devices/${deviceId}/scopes`, { scopes: ['files'] });
    expect(scoped.json.scopes).toEqual(['files']);
    expect(
      (await api('PUT', `/api/v1/devices/${deviceId}/scopes`, { scopes: ['BAD'] })).status,
    ).toBe(400);

    // Revoking it ends its session and blocks its key.
    expect((await api('POST', `/api/v1/devices/${deviceId}/revoke`)).json).toEqual({ ok: true });
    expect(await auth.verify(token)).toBeNull();
    const again = await start({ role: 'client' });
    const refused = await complete(again, key, 'browser');
    expect(refused.status).toBe(403);
    expect(refused.json.error.details).toEqual({ reason: 'key_revoked' });
    expect(
      (await api('POST', '/api/v1/devices/01920000-0000-7000-8000-00000000ffff/revoke')).status,
    ).toBe(404);

    // Events and audit name the steps and never carry the code or the session.
    const persisted = await events.since(null, 500);
    const names = persisted.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'device.add.requested',
        'device.add.decided',
        'device.status.changed',
      ]),
    );
    const trail = JSON.stringify([persisted, audit]);
    expect(trail).not.toContain(token);
    expect(trail).not.toContain(started.code.replace('-', ''));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'device.add.start',
        'device.add.complete',
        'device.add.approve',
        'device.scopes.update',
        'device.revoke',
      ]),
    );
  });

  it('can be denied', async () => {
    const started = await start({ role: 'client' });
    const key = newKey();
    const done = await complete(started, key, 'native');
    const id = done.json.requestId as string;
    const denied = await api('POST', `/api/v1/devices/add/requests/${id}/deny`);
    expect(denied.json.status).toBe('denied');
    expect((await poll(key, id)).json).toEqual({ status: 'denied' });
    expect((await api('POST', `/api/v1/devices/add/requests/${id}/deny`)).status).toBe(409);
    expect((await api('GET', '/api/v1/devices/add/requests?status=all')).json.items).toHaveLength(
      1,
    );
    expect((await api('GET', '/api/v1/devices/add/requests?status=nope')).status).toBe(400);
  });
});

describe('novad joins', () => {
  it('and registers at /agent/v1/register with the granted token and its own key', async () => {
    const started = await start({ role: 'wake-helper', name: 'NAS' });
    const key = newKey();
    const done = await complete(started, key, 'novad');
    const id = done.json.requestId as string;
    await api('POST', `/api/v1/devices/add/requests/${id}/approve`, {
      confirmation: `${done.json.confirmation.slice(0, 3)} ${done.json.confirmation.slice(3)}`,
    });
    const granted = await poll(key, id);
    expect(granted.headers.getSetCookie()).toEqual([]);
    expect(granted.json.grant.type).toBe('novad');
    const enrollToken = granted.json.grant.enrollToken as string;
    expect(enrollToken).toMatch(/^nvd_/);

    const capability = new FakeDevice({ name: 'nas', roles: ['wake-helper'] }).capability();
    const body = (publicKey: string, privateKey: KeyObject) => ({
      enrollToken,
      name: 'nas',
      endpoint: 'http://127.0.0.1:9',
      publicKey,
      capability,
      signature: sign(null, Buffer.from(canonicalJson(capability)), privateKey).toString(
        'base64url',
      ),
      managementToken: `nvdm_${'m'.repeat(43)}`,
      novadVersion: '0.6.0',
      protocolVersions: [1],
    });
    // Another key cannot use the token (and burns it).
    const other = newKey();
    const stolen = await api(
      'POST',
      '/agent/v1/register',
      body(other.publicKey, other.privateKey),
      {},
    );
    expect(stolen.status).toBe(403);
    expect(stolen.json.error.details).toEqual({ reason: 'key_mismatch' });

    // A fresh grant: add it again with the same key (its record is still pending).
    const s2 = await start({ role: 'wake-helper', name: 'NAS' });
    const d2 = await complete(s2, key, 'novad');
    await api('POST', `/api/v1/devices/add/requests/${d2.json.requestId}/approve`, {
      confirmation: d2.json.confirmation,
    });
    const g2 = await poll(key, d2.json.requestId as string);
    const reg = await api(
      'POST',
      '/agent/v1/register',
      { ...body(key.publicKey, key.privateKey), enrollToken: g2.json.grant.enrollToken },
      {},
    );
    expect(reg.status).toBe(201);
    expect(reg.json.deviceId).toBe(g2.json.deviceId);
    expect(reg.json.credential).toMatch(/^nvc_/);
    const beat = await api(
      'POST',
      '/agent/v1/heartbeat',
      { novadVersion: '0.6.0' },
      { authorization: `Bearer ${reg.json.credential}` },
    );
    expect(beat.status).toBe(200);
    const listed = await api('GET', '/api/v1/devices?role=wake-helper');
    expect(listed.json.items).toEqual([
      expect.objectContaining({ id: reg.json.deviceId, name: 'NAS', status: 'active' }),
    ]);

    // Revoked through the devices area: its key is blocked for Add Device too.
    expect((await api('POST', `/api/v1/devices/${reg.json.deviceId}/revoke`)).json).toEqual({
      ok: true,
    });
    const s3 = await start({ role: 'wake-helper' });
    expect((await complete(s3, key, 'novad')).json.error.details).toEqual({
      reason: 'key_revoked',
    });
  });
});

describe('a compute node joins', () => {
  let backend: FakeBackend;
  beforeEach(async () => {
    backend = await startFakeBackend({ models: ['llama3'] });
  });
  afterEach(async () => {
    await backend.close();
  });

  it('with nova-compute and the code alone, into /node/v1/register', async () => {
    const started = await start({ role: 'compute', name: 'gpu-box' });
    const shown: string[] = [];
    const joining = joinWithCode({
      hubUrl: url,
      code: started.code.toLowerCase(),
      backendUrl: backend.url,
      backendKind: 'llamacpp',
      name: 'reported-name',
      listen: '127.0.0.1:0',
      advertise: 'http://127.0.0.1:7420',
      dataDir: join(dir, 'node'),
      pollIntervalMs: 50,
      onConfirmation: (c) => shown.push(c),
    });
    let pending: { id: string; confirmation: string } | undefined;
    for (let i = 0; i < 200 && !pending; i++) {
      pending = (await api('GET', '/api/v1/devices/add/requests')).json.items[0];
      if (!pending) await new Promise((r) => setTimeout(r, 10));
    }
    expect(pending).toBeDefined();
    for (let i = 0; i < 200 && shown.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // Both screens agree.
    expect(shown).toEqual([pending!.confirmation]);
    await api('POST', `/api/v1/devices/add/requests/${pending!.id}/approve`, {
      confirmation: shown[0],
    });
    const state = await joining;
    const nodeId = state.enrollment!.nodeId;
    const listed = await api('GET', '/api/v1/devices?role=compute');
    expect(listed.json.items).toEqual([
      expect.objectContaining({
        id: nodeId,
        name: 'gpu-box',
        status: 'active',
        models: ['llama3'],
      }),
    ]);
    // Revoking the node audits it here and blocks its key.
    await api('POST', `/api/v1/devices/${nodeId}/revoke`);
    for (let i = 0; i < 100 && !audit.some((a) => a.action === 'device.revoke'); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(audit.find((a) => a.action === 'device.revoke')).toMatchObject({
      resource: nodeId,
      kind: 'device',
    });
    const blocked = db.raw.prepare('SELECT device_id FROM revoked_device_key').all();
    expect(blocked).toEqual([{ device_id: nodeId }]);
  }, 20_000);
});

describe('the seams', () => {
  it('put the bootstrap command, healthy endpoints, the fingerprint and the Relay in the answer', async () => {
    const calls: unknown[] = [];
    area.useBootstrap((role, code, hubUrl, pairingId) => {
      calls.push([role, code, hubUrl, pairingId]);
      return {
        command: `novad install --hub ${hubUrl} --code ${code} --pairing ${pairingId} --role ${role}`,
        powershell: `novad.exe install --pairing ${pairingId}`,
        why: null,
      };
    });
    area.useEndpoints(() =>
      Promise.resolve([
        { url: 'http://10.0.0.2:7419', health: 'ok' },
        { url: 'https://hub.tail.ts.net', health: 'failing' },
        { url: 'https://relay.example/hub', health: 'ok' },
        { url: 'javascript:alert(1)', health: 'ok' },
      ]),
    );
    const hubKey = generateKeyPairSync('ed25519');
    area.useHubIdentity(() => ({
      fingerprint: 'fp-123',
      sign: (bytes) => sign(null, Buffer.from(bytes), hubKey.privateKey),
    }));
    area.useRelayPairing(() =>
      Promise.resolve({ relayUrl: 'wss://relay.example', relayPairingId: 'rp-9' }),
    );
    area.useCertIssuer({
      issueDeviceCertificate: () => Promise.resolve({ certificatePem: 'PEM', expiresAt: 'x' }),
    });
    const s = await start({ role: 'compute', transport: 'relay' });
    // The command carries the pairing id, so its code never spends the code-only budget.
    expect(calls).toEqual([['compute', s.code, url, s.pairingId]]);
    expect(s.bootstrap).toEqual({
      command: `novad install --hub ${url} --code ${s.code} --pairing ${s.pairingId} --role compute`,
      // The Windows command reaches the page too.
      powershell: `novad.exe install --pairing ${s.pairingId}`,
      why: null,
    });
    expect(s.endpoints).toEqual(['http://10.0.0.2:7419', 'https://relay.example/hub']);
    expect(s.hubFingerprint).toBe('fp-123');
    expect(s.relay).toEqual({ relayUrl: 'wss://relay.example', relayPairingId: 'rp-9' });
    const qr = new URL(s.qr);
    expect(qr.searchParams.get('fp')).toBe('fp-123');
    expect(qr.searchParams.getAll('e')).toEqual(s.endpoints);
    expect(qr.searchParams.get('r')).toBe('wss://relay.example');
    expect(qr.searchParams.get('rp')).toBe('rp-9');
    expect(qr.hash).toBe(`#c=${s.code}`);

    area.useBootstrap(() => {
      throw new Error('no manifest');
    });
    area.useEndpoints(() => Promise.reject(new Error('probe failed')));
    const s2 = await start({ role: 'client' });
    expect(s2.bootstrap).toEqual({
      command: null,
      why: expect.stringMatching(/could not be built/),
    });
    expect(s2.endpoints).toEqual([]);
    area.useBootstrap(() => Promise.resolve({ command: null, why: 'no arm64 build' }));
    expect((await start({ role: 'client' })).bootstrap).toEqual({
      command: null,
      powershell: null,
      why: 'no arm64 build',
    });

    // The Hub identity is bound into the confirmation and signs the reveal answer; the grant
    // carries the certificate.
    const key = newKey();
    const browser = await start({ role: 'client' });
    const done = await complete(browser, key, 'browser');
    expect(done.json.confirmation).toBe(
      pairingConfirmationV2({
        hubFingerprint: 'fp-123',
        pairingId: browser.pairingId,
        publicKey: key.publicKey,
        code: browser.code,
        deviceNonce: done.deviceNonce,
        hubNonce: done.committed!.hubNonce,
      }),
    );
    expect(
      verify(
        null,
        hubRevealStatement({
          requestId: done.json.requestId as string,
          pairingId: browser.pairingId,
          publicKey: key.publicKey,
          confirmation: done.json.confirmation as string,
        }),
        hubKey.publicKey,
        Buffer.from(done.json.hubSignature as string, 'base64url'),
      ),
    ).toBe(true);
    await api('POST', `/api/v1/devices/add/requests/${done.json.requestId}/approve`, {
      confirmation: done.json.confirmation,
    });
    expect((await poll(key, done.json.requestId as string)).json.grant.certificatePem).toBe('PEM');
  });

  it('builds links that keep the code out of the query', () => {
    const l = addDeviceLinks({
      hubUrl: 'https://hub.local:7419',
      pairingId: 'p1',
      code: 'ABCD-EFGH',
      hubFingerprint: null,
      endpoints: [],
      relay: null,
    });
    expect(l.qr).toBe('https://hub.local:7419/add-device?p=p1#c=ABCD-EFGH');
    expect(new URL(l.qr).search).not.toContain('ABCD');
    expect(l.deepLink).toBe('nova://add-device?h=https%3A%2F%2Fhub.local%3A7419&p=p1#c=ABCD-EFGH');
  });
});

describe('per-address limits on the public routes', () => {
  it('answer 429 once an address sends too many', async () => {
    await area.close();
    await devices.close();
    await app.close();
    db.close();
    await build({
      complete: { limit: 2, windowMs: 60_000 },
      reveal: { limit: 1, windowMs: 60_000 },
      status: { limit: 1, windowMs: 60_000 },
    });
    const body = {
      code: 'AAAA-AAAA',
      publicKey: newKey().publicKey,
      name: 'x',
      platform: 'x',
      kind: 'browser',
      commitment: 'c'.repeat(43),
    };
    expect((await api('POST', '/api/v1/devices/add/complete', body, {})).status).toBe(410);
    expect((await api('POST', '/api/v1/devices/add/complete', body, {})).status).toBe(410);
    const third = await api('POST', '/api/v1/devices/add/complete', body, {});
    expect(third.status).toBe(429);
    expect(third.json.error.details).toEqual({ reason: 'address_rate_limited' });
    expect((await api('GET', '/api/v1/devices/add/status/x', undefined, {})).status).toBe(401);
    expect((await api('GET', '/api/v1/devices/add/status/x', undefined, {})).status).toBe(429);
    const r = { requestId: 'x', nonce: 'n'.repeat(43) };
    expect((await api('POST', '/api/v1/devices/add/reveal', r, {})).status).toBe(401);
    expect((await api('POST', '/api/v1/devices/add/reveal', r, {})).status).toBe(429);
  });
});

describe('Add Device v2 over HTTP (review findings 1 and 4)', () => {
  it('commits without a confirmation, reveals once, and burns a bad reveal', async () => {
    const started = await start({ role: 'client' });
    const key = newKey();
    const deviceNonce = randomBytes(32).toString('base64url');
    // A commitment is required.
    const noCommit = await api(
      'POST',
      '/api/v1/devices/add/complete',
      {
        pairingId: started.pairingId,
        code: started.code,
        publicKey: key.publicKey,
        name: 'x',
        platform: 'x',
        kind: 'browser',
      },
      {},
    );
    expect(noCommit.status).toBe(400);
    const c = await commit(started, key, 'browser', {}, deviceNonce);
    expect(c.status).toBe(202);
    expect(c.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(c.json).sort()).toEqual([
      'expiresAt',
      'hubNonce',
      'pairingId',
      'requestId',
      'status',
    ]);
    expect(c.json.status).toBe('committed');
    // The owner sees nothing before the reveal.
    expect((await api('GET', '/api/v1/devices/add/requests?status=all')).json.items).toEqual([]);
    // Missing proof, then a reveal signed by another key: the request is burned.
    const missing = await api(
      'POST',
      '/api/v1/devices/add/reveal',
      { requestId: c.json.requestId, nonce: deviceNonce },
      {},
    );
    expect(missing.status).toBe(401);
    expect(missing.json.error.details).toEqual({ reason: 'missing_proof' });
    const forged = await reveal(key, c.json.requestId as string, deviceNonce, newKey());
    expect(forged.status).toBe(401);
    expect(forged.json.error.details).toEqual({ reason: 'bad_reveal' });
    const late = await reveal(key, c.json.requestId as string, deviceNonce);
    expect(late.status).toBe(410);
    expect((await poll(key, c.json.requestId as string)).json).toEqual({ status: 'denied' });

    // A good one: pending for the owner; a second reveal is a conflict.
    const s2 = await start({ role: 'client' });
    const n2 = randomBytes(32).toString('base64url');
    const c2 = await commit(s2, key, 'browser', {}, n2);
    const ok = await reveal(key, c2.json.requestId as string, n2);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.json).toMatchObject({
      requestId: c2.json.requestId,
      status: 'pending',
      hubSignature: null,
    });
    const again = await reveal(key, c2.json.requestId as string, n2);
    expect(again.status).toBe(409);
    expect(again.json.error.details).toEqual({ reason: 'already_revealed' });
    expect((await api('GET', '/api/v1/devices/add/requests')).json.items).toEqual([
      expect.objectContaining({ id: c2.json.requestId, confirmation: ok.json.confirmation }),
    ]);
  });

  it('lets no unauthenticated client burn the open pairings with code-only guesses', async () => {
    // The reviewer's probe: five code-only guesses used to burn every open pairing.
    const a = await start({ role: 'client' });
    const b = await start({ role: 'compute' });
    const junk = newKey();
    for (let i = 0; i < 5; i++) {
      const r = await commit({ code: '00000000' }, junk, 'browser');
      expect(r.status).toBe(401);
    }
    // The owner's real devices still join on both pairings.
    expect((await complete(a, newKey(), 'browser')).status).toBe(200);
    expect((await complete(b, newKey(), 'compute')).status).toBe(200);
  });
});
