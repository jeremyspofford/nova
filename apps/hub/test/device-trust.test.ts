// Mutual TLS for novad devices and compute nodes (FR-126, R-022; docs/22 §5, §9.1): a real HTTPS
// listener on loopback (main.ts `tlsListener`, which asks for but never requires a client
// certificate) in front of stand-ins for the device and node routes, the real trust area in
// local-CA mode issuing device certificates, and node:https clients presenting good, revoked,
// foreign, mismatched and missing certificates. Plain HTTP is not affected; a browser without a
// certificate still connects; the setting decides about devices without one.
import { generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { request } from 'node:https';
import { connect } from 'node:tls';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  uuidv7,
  type DeviceTlsSummaryView,
  type SettingKey,
} from '@nova/shared';
import {
  buildCertificate,
  deviceSecretHash,
  nodeSecretHash,
  rawEd25519,
  type AuditRecord,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupDeviceTrust, type DeviceTrustArea } from '../src/device-trust.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { tlsListener } from '../src/main.ts';
import { setupTrust, type TrustArea } from '../src/trust.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';

interface Device {
  id: string;
  credential: string;
  key: KeyObject;
  keyPem: string;
  publicKey: string;
  certPem: string;
}

let db: NovaDatabase;
let app: FastifyInstance;
let trust: TrustArea;
let area: DeviceTrustArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
let stored: Record<string, unknown>;
let listener: Awaited<ReturnType<typeof tlsListener>>;
let port: number;
let ca: string;
let novad: Device;
let other: Device;
let node: Device;
let handled: string[];

function setting<K extends SettingKey>(key: K) {
  return Promise.resolve(resolveSetting(key, { global: stored, managed: {} }).value);
}

/** A device row with a credential, the way DeviceService and NodeService register them. */
/** `withCert: false`: a device added before the Hub had a local CA (no certificate issued). */
async function addDevice(
  kind: 'novad' | 'compute',
  name: string,
  withCert = true,
): Promise<Device> {
  const id = uuidv7();
  const credential =
    kind === 'novad'
      ? `nvc_${Buffer.from(uuidv7()).toString('base64url')}`
      : `nvn_${Buffer.from(uuidv7()).toString('base64url')}`;
  const tokenId = uuidv7();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = rawEd25519(publicKey).toString('base64url');
  const iso = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO auth_token (id, kind, token_hash, account_id, label, scopes, created_at)
       VALUES (?, 'device', ?, ?, ?, '[]', ?)`,
    )
    .run(
      tokenId,
      kind === 'novad' ? deviceSecretHash(credential) : nodeSecretHash(credential),
      ACCOUNT,
      name,
      iso,
    );
  db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles,
         status, credential_token_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?, ?)`,
    )
    .run(
      id,
      ACCOUNT,
      name,
      kind === 'novad' ? 'client' : 'compute',
      `fp-${id}`,
      raw,
      tokenId,
      iso,
      iso,
    );
  const issued = withCert
    ? await trust.certIssuer.issueDeviceCertificate({
        deviceId: id,
        publicKey: raw,
        role: kind === 'novad' ? 'client' : 'compute',
      })
    : { certificatePem: '' };
  return {
    id,
    credential,
    key: privateKey,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: raw,
    certPem: issued!.certificatePem,
  };
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  stored = { 'trust.mode': 'local-ca' };
  audit = [];
  diagnostics = new DiagnosticsRegistry();
  events = new EventStore(db);
  const ctx = {
    db,
    secrets: new MemorySecretStore(),
    events,
    config: { host: '127.0.0.1', allowedOrigins: [] },
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting,
    accountOf: (req: { headers: Record<string, unknown> }) =>
      req.headers.authorization === 'Bearer owner'
        ? Promise.resolve(ACCOUNT)
        : Promise.reject(new NovaError('token_required', 'sign in')),
  } as unknown as HubContext;
  trust = await setupTrust(ctx, {
    hostname: () => 'hub',
    interfaces: () => ({}),
  });
  area = await setupDeviceTrust(ctx, {
    verifyDeviceCertificate: (pem) => trust.verifyDeviceCertificate(pem),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
  });
  novad = await addDevice('novad', 'desk');
  other = await addDevice('novad', 'laptop');
  node = await addDevice('compute', 'gpu-box');
  handled = [];
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  area.register(app);
  // Stand-ins for the devices area and the node routes: they answer after the area's check.
  for (const path of [
    '/agent/v1/register',
    '/agent/v1/heartbeat',
    '/agent/v1/capabilities',
    '/node/v1/register',
    '/node/v1/heartbeat',
    '/node/v1/models/sync',
  ])
    app.post(path, () => (handled.push(path), { ok: true }));
  app.get('/api/v1/hello', () => ({ name: 'nova-hub' }));
  const material = await trust.tls.material();
  ca = trust.service.caCertificate()!;
  listener = await tlsListener(app, { ...material!, clientCa: ca });
  port = await listener.listen(0, '127.0.0.1');
});

afterEach(async () => {
  await listener.close();
  await area.close();
  await trust.close();
  await app.close();
  db.close();
});

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

function call(
  path: string,
  opts: { cert?: string; key?: string; bearer?: string; body?: unknown; method?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(opts.body ?? {});
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'POST',
        agent: false,
        ca,
        ...(opts.cert ? { cert: opts.cert, key: opts.key } : {}),
        headers: {
          ...(opts.method === 'GET' ? {} : { 'content-type': 'application/json' }),
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
              string,
              unknown
            >,
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.method !== 'GET') req.write(body);
    req.end();
  });
}

const reason = (r: Reply) => (r.json.error as { details?: { reason?: string } }).details?.reason;
const as = (d: Device) => ({ cert: d.certPem, key: d.keyPem, bearer: d.credential });

describe('mutual TLS on the device and node routes (FR-126)', () => {
  it('asks for a certificate of the Hub local CA without requiring one', async () => {
    const accepted = await new Promise<string[]>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port, ca, servername: undefined }, () => {
        // The handshake completed with no client certificate (a browser).
        resolve([String(socket.authorized)]);
        socket.end();
      });
      socket.on('error', reject);
    });
    expect(accepted).toEqual(['true']);
    expect((await call('/api/v1/hello', { method: 'GET' })).status).toBe(200);
  });

  it('accepts the device certificate of the caller and records it', async () => {
    const hb = await call('/agent/v1/heartbeat', as(novad));
    expect(hb.status, JSON.stringify(hb.json)).toBe(200);
    expect((await call('/node/v1/heartbeat', as(node))).status).toBe(200);
    expect(handled).toEqual(['/agent/v1/heartbeat', '/node/v1/heartbeat']);
    const summary = await area.summary(ACCOUNT);
    expect(summary.requireCertificate).toBe(false);
    expect(summary.items.map((i) => [i.name, i.kind, i.certificate])).toEqual(
      expect.arrayContaining([
        ['desk', 'novad', 'verified'],
        ['gpu-box', 'compute', 'verified'],
      ]),
    );
    expect(summary.items.find((i) => i.deviceId === novad.id)?.serial).toBe(
      new X509Certificate(novad.certPem).serialNumber.toLowerCase(),
    );
    expect(summary.problems).toEqual([]);
    const changed = db.raw
      .prepare("SELECT payload_json FROM event WHERE name = 'device.tls.changed'")
      .all() as { payload_json: string }[];
    expect(
      changed.map((e) => (JSON.parse(e.payload_json) as { certificate: string }).certificate),
    ).toEqual(['verified', 'verified']);
    // Registration ties the certificate to the key in the body.
    expect(
      (await call('/agent/v1/register', { ...as(novad), body: { publicKey: novad.publicKey } }))
        .status,
    ).toBe(200);
    const wrongKey = await call('/node/v1/register', {
      ...as(node),
      body: { publicKey: novad.publicKey },
    });
    expect([wrongKey.status, reason(wrongKey)]).toEqual([403, 'certificate_mismatch']);
  });

  it('refuses revoked, foreign and other devices’ certificates', async () => {
    // Another device's valid certificate with this device's credential.
    const swapped = await call('/agent/v1/heartbeat', {
      cert: other.certPem,
      key: other.keyPem,
      bearer: novad.credential,
    });
    expect([swapped.status, reason(swapped)]).toEqual([403, 'certificate_mismatch']);
    // A certificate the Hub local CA never issued.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const elsewhere = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const foreign = buildCertificate({
      subject: { commonName: novad.id },
      issuer: { commonName: 'Someone else' },
      publicKey,
      signer: elsewhere.privateKey,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      keyUsage: 0x80,
      extKeyUsage: ['1.3.6.1.5.5.7.3.2'],
      altNames: { uris: [`urn:nova:device:${novad.id}`] },
    });
    const self = await call('/agent/v1/heartbeat', {
      cert: foreign.pem,
      key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      bearer: novad.credential,
    });
    expect([self.status, reason(self)]).toEqual([403, 'certificate_unknown_issuer']);
    // Revoked by the trust area (device revocation does this too): refused even with a live
    // credential.
    await trust.revokeDevice(node.id);
    const revoked = await call('/node/v1/models/sync', as(node));
    expect([revoked.status, reason(revoked)]).toEqual([403, 'certificate_revoked']);
    expect(handled).toEqual([]);
    expect(audit.map((a) => [a.action, a.resource, a.detail?.reason])).toEqual([
      ['device.tls.refuse', novad.id, 'certificate_mismatch'],
      ['device.tls.refuse', novad.id, 'certificate_unknown_issuer'],
      ['device.tls.refuse', node.id, 'certificate_revoked'],
    ]);
    // The same refusal again within the hour is not audited again.
    await call('/node/v1/models/sync', as(node));
    expect(audit).toHaveLength(3);
    const summary = await area.summary(ACCOUNT);
    expect(summary.problems.join(' ')).toMatch(
      /refused over HTTPS: .*gpu-box \(certificate_revoked\)/,
    );
  });

  it('never lets a device that holds a certificate call without it', async () => {
    // The setting is on, but this device's bearer credential alone (perhaps captured over plain
    // HTTP before the move to HTTPS) is not enough: it holds a live certificate.
    const bare = await call('/agent/v1/heartbeat', { bearer: novad.credential });
    expect([bare.status, reason(bare)]).toEqual([403, 'certificate_required']);
    const join = await call('/node/v1/register', { body: { publicKey: node.publicKey } });
    expect([join.status, reason(join)]).toEqual([403, 'certificate_required']);
    expect(handled).toEqual([]);
    expect(audit.map((a) => [a.action, a.resource, a.detail?.reason])).toEqual([
      ['device.tls.refuse', novad.id, 'certificate_required'],
      ['device.tls.refuse', node.id, 'certificate_required'],
    ]);
    expect((await area.summary(ACCOUNT)).items.find((i) => i.deviceId === novad.id)).toMatchObject({
      certificate: 'refused',
      reason: 'certificate_required',
    });
    // With its certificate it gets in; once the certificate is revoked the setting decides again
    // (and the revoked certificate itself is refused).
    expect((await call('/agent/v1/heartbeat', as(novad))).status).toBe(200);
    await trust.revokeDevice(novad.id);
    expect((await call('/agent/v1/heartbeat', { bearer: novad.credential })).status).toBe(200);
    expect(reason(await call('/agent/v1/heartbeat', as(novad)))).toBe('certificate_revoked');
  });

  it('lets the setting decide about a device that never got a certificate', async () => {
    // Devices added before the Hub had a local CA.
    const old = await addDevice('novad', 'old-desk', false);
    const oldNode = await addDevice('compute', 'old-gpu', false);
    const bare = await call('/agent/v1/heartbeat', { bearer: old.credential });
    expect(bare.status).toBe(200);
    const summary = await area.summary(ACCOUNT);
    expect(summary.items[0]).toMatchObject({ deviceId: old.id, certificate: 'missing' });
    expect(summary.problems).toEqual([
      expect.stringMatching(
        /^1 device reaches the Hub over HTTPS without a device certificate \(.+\): it is accepted .*; add it again .* to give it one\.$/,
      ),
    ]);
    expect((await diagnostics.collect()).deviceTls).toMatchObject({ missing: 1 });
    // Two devices: the plural forms.
    expect((await call('/node/v1/models/sync', { bearer: oldNode.credential })).status).toBe(200);
    expect((await area.summary(ACCOUNT)).problems).toEqual([
      expect.stringMatching(
        /^2 devices reach the Hub over HTTPS without a device certificate \(.+, .+\): they are accepted .*; add them again .* to give each one\.$/,
      ),
    ]);
    stored['devices.tls.allowWithoutCertificate'] = false;
    const refused = await call('/agent/v1/heartbeat', { bearer: old.credential });
    expect([refused.status, reason(refused)]).toEqual([403, 'certificate_required']);
    const register = await call('/node/v1/register', { body: { publicKey: oldNode.publicKey } });
    expect([register.status, reason(register)]).toEqual([403, 'certificate_required']);
    expect((await area.summary(ACCOUNT)).requireCertificate).toBe(true);
    // A device with its certificate still gets in.
    expect((await call('/agent/v1/heartbeat', as(novad))).status).toBe(200);
  });

  it('leaves plain HTTP, unknown credentials and other routes to their own checks', async () => {
    stored['devices.tls.allowWithoutCertificate'] = false;
    // Plain HTTP (and requests the Relay tunnels in) are not checked here.
    const plain = await app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      headers: { authorization: `Bearer ${novad.credential}` },
      payload: {},
    });
    expect(plain.statusCode).toBe(200);
    // An unknown credential reaches the route, which answers 401 itself (the stand-in says ok).
    expect((await call('/agent/v1/heartbeat', { bearer: 'nvc_unknown' })).status).toBe(200);
    expect((await call('/agent/v1/heartbeat', {})).status).toBe(200);
    expect(await area.summary(ACCOUNT)).toMatchObject({ items: [] });
  });

  it('serves the summary to the owner only and forgets revoked devices', async () => {
    await call('/agent/v1/heartbeat', as(novad));
    const anon = await app.inject({ method: 'GET', url: '/api/v1/devices/tls' });
    expect(anon.statusCode).toBe(401);
    const owner = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/tls',
      headers: { authorization: 'Bearer owner' },
    });
    expect(owner.json<DeviceTlsSummaryView>().items).toHaveLength(1);
    await events.emit({
      name: 'device.status.changed',
      accountId: ACCOUNT,
      payload: { deviceId: novad.id, status: 'revoked' },
    });
    expect((await area.summary(ACCOUNT)).items).toEqual([]);
  });
});
