// M7.5 device operations (ADR-096 D1, D3, D9; FR-126, FR-142, FR-145, FR-148, FR-150) against a
// fake novad: the management channel over mutual TLS (a device certificate of the Hub CA is
// accepted; a certificate naming another device, carrying another key, issued by another CA or
// revoked is refused; an https device offering http is refused, never downgraded), the heartbeat
// answer's device policy, decommission (approval, a D2 authorization, online and offline), and the
// routes the M6 UI lacked (managed services, available updates, owner overrides).
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
} from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  DECOMMISSION_APPROVAL_TTL_MS,
  FakeDevice,
  TrustService,
  ed25519FromRaw,
  managementTokenRef,
  rawEd25519,
  tlsFailureOf,
  type DeviceTlsTrust,
} from '../src/index.ts';
import { buildCertificate, keyId } from '../src/trust/x509.ts';
import { uuidv7 } from '@nova/shared';
import { ACCOUNT, OTHER, devicesEnv, type DevicesEnv } from './devices-env.ts';

const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

let env: DevicesEnv;
let trust: TrustService;
const servers: Server[] = [];

function trustFor(e: DevicesEnv): TrustService {
  return new TrustService({
    db: e.db,
    secrets: e.secrets,
    settings: {
      mode: () => Promise.resolve('local-ca'),
      meshCerts: () => Promise.resolve(false),
      pinNativeShells: () => Promise.resolve(true),
    },
    names: () => Promise.resolve(['nova-hub.local', '127.0.0.1']),
    ownerAccount: () => Promise.resolve(ACCOUNT),
  });
}

const tlsOf = (t: TrustService): DeviceTlsTrust => ({
  material: () => t.hubClientCertificate(),
  verifyDeviceCertificate: (pem) => t.verifyDeviceCertificate(pem),
});

beforeEach(async () => {
  env = await devicesEnv();
  trust = trustFor(env);
  await trust.start();
  await trust.ensureCa();
  env.svc.useManagementTls(tlsOf(trust));
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await env.close();
});

async function rejects(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

/** Issue the device its certificate, serve HTTPS with it and report the endpoint (D1). */
async function toHttps(fake: FakeDevice): Promise<string> {
  const cert = await trust.issueDeviceCertificate({
    deviceId: fake.deviceId!,
    publicKey: fake.publicKey,
    role: 'client',
  });
  const url = await fake.listenTls({
    certPem: cert!.certificatePem,
    caPem: trust.caCertificate()!,
  });
  const hb = await fake.heartbeat({ endpoint: url });
  expect(hb.status).toBe(200);
  return url;
}

/** A bare HTTPS server with any key and certificate, answering `{ok: true}`. */
async function serveTls(opts: { key: string; cert: string; ca: string }): Promise<string> {
  const server = createServer(
    { ...opts, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ novadVersion: '0.6.0', modules: [] }));
    },
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `https://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Another CA and a certificate from it for the device's id and key. */
function foreignCertificate(deviceId: string, devicePublicKey: string) {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = Date.now();
  const caCert = buildCertificate({
    subject: { commonName: 'Another CA' },
    issuer: { commonName: 'Another CA' },
    publicKey: ca.publicKey,
    signer: ca.privateKey,
    notBefore: new Date(now - 3_600_000),
    notAfter: new Date(now + 86_400_000),
    ca: { pathLength: 0 },
    keyUsage: 0x86,
  });
  const leaf = buildCertificate({
    subject: { commonName: deviceId },
    issuer: { commonName: 'Another CA' },
    publicKey: ed25519FromRaw(devicePublicKey),
    signer: ca.privateKey,
    notBefore: new Date(now - 3_600_000),
    notAfter: new Date(now + 86_400_000),
    keyUsage: 0x80,
    extKeyUsage: [CLIENT_AUTH, SERVER_AUTH],
    altNames: { uris: [`urn:nova:device:${deviceId}`] },
  });
  return { caPem: caCert.pem, certPem: leaf.pem, caKey: ca.privateKey };
}

function signer(): { sign: (b: Uint8Array | string) => Buffer; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    sign: (b) => sign(null, typeof b === 'string' ? Buffer.from(b) : Buffer.from(b), privateKey),
    publicKey: rawEd25519(publicKey).toString('base64url'),
  };
}

/** The owner answers a card (what the approvals route does), then the area passes it on. */
async function answer(approvalId: string, decision: string, by = 'user'): Promise<void> {
  env.db.raw
    .prepare(
      `UPDATE approval SET status = ?, decision = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
    )
    .run(
      decision === 'timeout' ? 'expired' : 'decided',
      decision,
      by,
      new Date(env.clock.now).toISOString(),
      approvalId,
    );
  await env.svc.onApprovalDecided(ACCOUNT, approvalId, decision);
}

describe('the Hub client certificate (D1)', () => {
  it('carries the Hub URI and clientAuth, lives in the vault and is renewed with the leaf', async () => {
    const c = (await trust.hubClientCertificate())!;
    const x = new X509Certificate(c.certPem);
    expect(x.subjectAltName).toBe(`URI:urn:nova:hub:${trust.identity.fingerprint}`);
    expect(x.keyUsage).toEqual([CLIENT_AUTH]);
    expect(x.checkIssued(new X509Certificate(trust.caCertificate()!))).toBe(true);
    expect(c.uri).toBe(`urn:nova:hub:${trust.identity.fingerprint}`);
    const stored = JSON.parse((await env.secrets.get('secret://hub/client-certificate'))!) as {
      certPem: string;
      keyPem: string;
    };
    expect(stored.certPem).toBe(c.certPem);
    expect(stored.keyPem).toContain('PRIVATE KEY');
    // The same one while it is young; a new one when forced or after a CA rotation.
    expect((await trust.hubClientCertificate())!.serial).toBe(c.serial);
    expect((await trust.hubClientCertificate({ force: true }))!.serial).not.toBe(c.serial);
    await trust.rotateCa();
    const after = (await trust.hubClientCertificate())!;
    expect(new X509Certificate(after.certPem).checkIssued(new X509Certificate(after.caPem))).toBe(
      true,
    );
    expect(after.caPem).toBe(trust.caCertificate());
    // A device certificate can serve the management endpoint too.
    const dev = await trust.issueDeviceCertificate({
      deviceId: 'dev-1',
      publicKey: rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url'),
      role: 'client',
    });
    expect(new X509Certificate(dev!.certificatePem).keyUsage?.sort()).toEqual(
      [CLIENT_AUTH, SERVER_AUTH].sort(),
    );
  });

  it('is renewed at two thirds of its life, and absent without a local CA', async () => {
    const clock = { t: Date.now() };
    const t2 = new TrustService({
      db: env.db,
      secrets: env.secrets,
      settings: {
        mode: () => Promise.resolve('none'),
        meshCerts: () => Promise.resolve(false),
        pinNativeShells: () => Promise.resolve(true),
      },
      names: () => Promise.resolve([]),
      now: () => new Date(clock.t),
    });
    const first = (await t2.hubClientCertificate())!;
    clock.t += 59 * 86_400_000;
    expect((await t2.hubClientCertificate())!.serial).toBe(first.serial);
    clock.t += 2 * 86_400_000;
    expect((await t2.hubClientCertificate())!.serial).not.toBe(first.serial);
    // maintain() keeps it current too.
    clock.t += 61 * 86_400_000;
    await t2.maintain();
    const kept = JSON.parse((await env.secrets.get('secret://hub/client-certificate'))!) as {
      certPem: string;
    };
    expect(Date.parse(new X509Certificate(kept.certPem).validTo)).toBeGreaterThan(clock.t);

    const env2 = await devicesEnv();
    try {
      const bare = trustFor(env2);
      await bare.start();
      expect(await bare.hubClientCertificate()).toBeNull();
    } finally {
      await env2.close();
    }
  });
});

describe('the management channel over mutual TLS (D1)', () => {
  it('reaches a device whose certificate the Hub CA issued, presenting the Hub client certificate', async () => {
    const fake = await env.enroll({ modules: ['management', 'storage', 'compute'] });
    const url = await toHttps(fake);
    const view = await env.svc.get(ACCOUNT, fake.deviceId!);
    expect(view.endpoint).toBe(url);
    expect(env.events.names()).toContain('device.endpoint.changed');
    expect(env.audit.find((a) => a.action === 'device.endpoint.change')?.detail).toMatchObject({
      after: url,
      channel: 'mutual_tls',
    });
    const items = await env.svc.services(ACCOUNT, fake.deviceId!);
    expect(items).toEqual([
      { name: 'compute', kind: 'module', state: 'running', module: 'compute', unit: null },
    ]);
    const presented = new X509Certificate(fake.clientCerts.at(-1)!);
    expect(presented.subjectAltName).toBe(`URI:urn:nova:hub:${trust.identity.fingerprint}`);
    const summary = await env.svc.managementTls(ACCOUNT);
    expect(summary.items[0]).toMatchObject({
      deviceId: fake.deviceId,
      channel: 'mutual_tls',
      lastCall: { ok: true, failure: null },
    });
    expect(summary.hubClient?.uri).toBe(`urn:nova:hub:${trust.identity.fingerprint}`);
    // Other areas' calls (the browser area) go the same way, the device found by its endpoint.
    const token = (await env.secrets.get(managementTokenRef(fake.deviceId!)))!;
    const r = await env.svc.managementTransport.post(`${url}/agent/v1/status`, token, {}, 5000);
    expect(r.status).toBe(200);
    expect((r.body as { deviceId: string }).deviceId).toBe(fake.deviceId);
    // A raw connection for the DevTools relay passes the same checks.
    const sock = await env.svc.connectManagementTls(new URL(url), fake.deviceId!);
    expect((sock as unknown as { authorized: boolean }).authorized).toBe(true);
    sock.destroy();
    await expect(
      env.svc.connectManagementTls(new URL('https://127.0.0.1:1'), fake.deviceId!),
    ).rejects.toMatchObject({ details: { tls: 'wrong_device' } });
  });

  it('refuses a certificate that names another device', async () => {
    const fake = await env.enroll();
    await toHttps(fake);
    const other = await trust.issueDeviceCertificate({
      deviceId: 'someone-else',
      publicKey: fake.publicKey,
      role: 'client',
    });
    const url = await fake.listenTls({
      certPem: other!.certificatePem,
      caPem: trust.caCertificate()!,
    });
    expect((await fake.heartbeat({ endpoint: url })).status).toBe(200);
    const err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    expect(err.code).toBe('policy_denied');
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'wrong_device' });
    expect((await env.svc.managementTls(ACCOUNT)).problems.join(' ')).toContain('wrong_device');
    // Nothing reached the device: no request was sent over that connection.
    expect(fake.calls.filter((c) => c.path === '/agent/v1/power')).toEqual([]);
  });

  it('refuses a certificate from another CA, and one with another key', async () => {
    const fake = await env.enroll();
    await toHttps(fake);
    const foreign = foreignCertificate(fake.deviceId!, fake.publicKey);
    const url = await fake.listenTls({ certPem: foreign.certPem, caPem: trust.caCertificate()! });
    await fake.heartbeat({ endpoint: url });
    let err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'untrusted_certificate' });

    // The right device id from the right CA, but not the key the Hub pinned at registration.
    const other = generateKeyPairSync('ed25519');
    const otherRaw = rawEd25519(other.publicKey).toString('base64url');
    const wrongKey = await trust.issueDeviceCertificate({
      deviceId: fake.deviceId!,
      publicKey: otherRaw,
      role: 'client',
    });
    const url2 = await serveTls({
      key: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      cert: wrongKey!.certificatePem,
      ca: trust.caCertificate()!,
    });
    await fake.heartbeat({ endpoint: url2 });
    err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'key_mismatch' });
  });

  it('refuses a revoked certificate, and a Hub without a client certificate', async () => {
    const fake = await env.enroll();
    await toHttps(fake);
    expect(await env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' })).toBeTruthy();
    await trust.revokeDevice(fake.deviceId!);
    let err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'revoked' });

    env.svc.useManagementTls({ material: () => Promise.resolve(null) });
    err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'no_ca' });
  });

  it('fails the handshake when the device refuses the Hub certificate', async () => {
    const fake = await env.enroll();
    await toHttps(fake);
    // A client certificate the device's CA did not issue.
    const foreign = foreignCertificate('hub', fake.publicKey);
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const now = Date.now();
    const client = buildCertificate({
      subject: { commonName: 'not the hub' },
      issuer: { commonName: 'Another CA' },
      publicKey: key.publicKey,
      signer: foreign.caKey,
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 86_400_000),
      keyUsage: 0x80,
      extKeyUsage: [CLIENT_AUTH],
    });
    env.svc.useManagementTls({
      material: () =>
        Promise.resolve({
          certPem: client.pem,
          keyPem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          caPem: trust.caCertificate()!,
        }),
      verifyDeviceCertificate: (pem) => trust.verifyDeviceCertificate(pem),
    });
    const err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    // The device closes the connection once it saw the Hub's certificate.
    expect(err.code).toBe('policy_denied');
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'handshake_failed' });
    expect(fake.calls.filter((c) => c.path === '/agent/v1/power')).toEqual([]);
  });

  it('never moves an https device back to http, and takes https only with a certificate', async () => {
    const fake = await env.enroll();
    const httpUrl = fake.endpoint;
    // https without a certificate the Hub issued: kept on http, audited.
    const r0 = await env.svc.heartbeat(fake.credential!, {
      novadVersion: '0.6.0',
      endpoint: 'https://127.0.0.1:9',
    });
    expect(r0.ok).toBe(true);
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).endpoint).toBe(httpUrl);
    expect(env.audit.find((a) => a.action === 'device.endpoint.refuse')?.detail).toMatchObject({
      reason: 'https_needs_certificate',
    });
    // A plain-HTTP address never moves by a heartbeat.
    await env.svc.heartbeat(fake.credential!, {
      novadVersion: '0.6.0',
      endpoint: 'http://10.0.0.99:7420',
    });
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).endpoint).toBe(httpUrl);

    const url = await toHttps(fake);
    const down = await rejects(
      env.svc.heartbeat(fake.credential!, { novadVersion: '0.6.0', endpoint: httpUrl }),
    );
    expect(down.code).toBe('policy_denied');
    expect(down.details).toEqual({ reason: 'endpoint_downgrade' });
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).endpoint).toBe(url);
    // Audited once an hour, not per beat.
    await rejects(
      env.svc.heartbeat(fake.credential!, { novadVersion: '0.6.0', endpoint: httpUrl }),
    );
    expect(
      env.audit.filter(
        (a) =>
          a.action === 'device.endpoint.refuse' &&
          (a.detail as { reason?: string }).reason === 'endpoint_downgrade',
      ),
    ).toHaveLength(1);
    // A device that serves plain HTTP at its https address is not called over it: the channel
    // fails closed and no request reaches it.
    const { createServer: plain } = await import('node:http');
    const seen: string[] = [];
    const s = plain((req, res) => {
      seen.push(req.url ?? '');
      res.end('{}');
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    env.db.raw
      .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
      .run(`https://127.0.0.1:${(s.address() as { port: number }).port}`, fake.deviceId);
    const err = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' }));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'handshake_failed' });
    expect(seen).toEqual([]);
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('refuses an https registration without the device certificate', async () => {
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client'], env.hubUrl);
    const fake = new FakeDevice();
    env.devices.push(fake);
    const capability = fake.capability();
    const err = await rejects(
      env.svc.register({
        enrollToken: t.token,
        name: 'tls',
        endpoint: 'https://127.0.0.1:7420',
        publicKey: fake.publicKey,
        capability,
        signature: fake.sign(capability),
        managementToken: fake.managementToken,
        novadVersion: '0.6.0',
        protocolVersions: [1],
      }),
    );
    expect(err.code).toBe('validation');
    expect(err.details).toMatchObject({ reason: 'https_needs_certificate' });
  });

  it('maps TLS errors', () => {
    expect(tlsFailureOf({ code: 'CERT_HAS_EXPIRED' })).toBe('expired');
    expect(tlsFailureOf({ code: 'CERT_NOT_YET_VALID' })).toBe('not_yet_valid');
    expect(tlsFailureOf({ code: 'INVALID_PURPOSE' })).toBe('unsupported_purpose');
    expect(tlsFailureOf({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe('untrusted_certificate');
    expect(tlsFailureOf({ code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' })).toBe(
      'handshake_failed',
    );
    expect(tlsFailureOf({ code: 'ECONNREFUSED' })).toBeNull();
    expect(tlsFailureOf(null)).toBeNull();
  });
});

describe('the heartbeat answer carries the device policy (D3)', () => {
  it('is off by default, follows the providers and fails closed', async () => {
    const fake = await env.enroll();
    let hb = await fake.heartbeat();
    expect(hb.json.policy).toEqual({ firmwareChanges: false, lowLevelBoot: false });
    const asked: string[] = [];
    env.svc.useFirmwarePolicy(({ deviceId }) => {
      asked.push(deviceId);
      return Promise.resolve(true);
    });
    env.svc.useBootPolicy(() => Promise.reject(new Error('boom')));
    hb = await fake.heartbeat();
    expect(hb.json.policy).toEqual({ firmwareChanges: true, lowLevelBoot: false });
    expect(asked).toEqual([fake.deviceId]);
    env.svc.useFirmwarePolicy(null);
    env.svc.useBootPolicy(() => Promise.resolve(true));
    hb = await fake.heartbeat();
    expect(hb.json.policy).toEqual({ firmwareChanges: false, lowLevelBoot: true });
  });
});

describe('decommission (D9)', () => {
  it('waits for approval, tells the device with a signed authorization and revokes it', async () => {
    const hub = signer();
    env.svc.useAuthzSigner(hub);
    const fake = await env.enroll({ hubKey: hub.publicKey, now: () => new Date(env.clock.now) });
    const req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: true });
    expect(req).toMatchObject({ status: 'awaiting_approval', purge: true, deviceResult: null });
    const card = env.db.raw.prepare('SELECT * FROM approval WHERE id = ?').get(req.approvalId) as {
      risk: string;
      tool_name: string;
      requested_action: string;
    };
    expect(card).toMatchObject({ risk: 'high', tool_name: 'device.decommission' });
    expect(card.requested_action).toContain('delete its Nova data');
    expect(env.events.names()).toContain('approval.requested');
    // Nothing happens before the answer, and a second request waits for the first.
    expect(fake.decommissioned).toBeNull();
    const dup = await rejects(
      env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false }),
    );
    expect(dup.details).toMatchObject({ reason: 'decommission_pending' });

    await answer(req.approvalId!, 'allow_once');
    expect(fake.decommissioned).toEqual({ purge: true });
    const done = (await env.svc.decommission(ACCOUNT, fake.deviceId!))!;
    expect(done).toMatchObject({ status: 'done', deviceResult: 'wiped', detail: null });
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).status).toBe('revoked');
    expect(await env.secrets.get(managementTokenRef(fake.deviceId!))).toBeNull();
    const call = fake.calls.find((c) => c.path === '/agent/v1/decommission')!;
    const authz = call.body.authorization as { payload: Record<string, unknown> };
    expect(authz.payload).toMatchObject({
      kind: 'device.decommission',
      deviceId: fake.deviceId,
      approvalId: req.approvalId,
    });
    const audit = env.audit.find((a) => a.action === 'device.decommission')!;
    expect(audit.detail).toMatchObject({
      purge: true,
      deviceResult: 'wiped',
      before: { status: 'active' },
      after: { status: 'revoked' },
    });
    expect(env.events.names()).toContain('device.decommissioned');
    // The device's next heartbeat is refused: it wipes its credentials.
    expect((await fake.heartbeat()).status).toBe(401);
    await expect(
      env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('revokes an offline device at once; it learns at its next contact', async () => {
    env.svc.useAuthzSigner(signer());
    const fake = await env.enroll();
    env.clock.now += 60_000;
    await env.svc.sweep();
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).status).toBe('unreachable');
    const req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false });
    await answer(req.approvalId!, 'allow_once');
    expect(await env.svc.decommission(ACCOUNT, fake.deviceId!)).toMatchObject({
      status: 'done',
      deviceResult: 'unreachable',
    });
    expect(fake.calls.some((c) => c.path === '/agent/v1/decommission')).toBe(false);
    expect((await fake.heartbeat()).status).toBe(401);
    expect(fake.revoked).toBe(true);
  });

  it('revokes anyway when the device refuses or the Hub cannot sign', async () => {
    // The device pinned another Hub key: it refuses the authorization.
    env.svc.useAuthzSigner(signer());
    const a = await env.enroll({
      hubKey: signer().publicKey,
      now: () => new Date(env.clock.now),
    });
    let req = await env.svc.requestDecommission(ACCOUNT, a.deviceId!, { purge: false });
    await answer(req.approvalId!, 'allow_once');
    const refused = (await env.svc.decommission(ACCOUNT, a.deviceId!))!;
    expect(refused).toMatchObject({ status: 'done', deviceResult: 'refused' });
    expect(refused.detail).toContain('authorization_invalid');
    expect(a.decommissioned).toBeNull();
    expect((await env.svc.get(ACCOUNT, a.deviceId!)).status).toBe('revoked');

    env.svc.useAuthzSigner(null);
    const b = await env.enroll();
    req = await env.svc.requestDecommission(ACCOUNT, b.deviceId!, { purge: false });
    await answer(req.approvalId!, 'allow_once');
    expect(await env.svc.decommission(ACCOUNT, b.deviceId!)).toMatchObject({
      deviceResult: 'not_told',
    });
    expect(b.calls.some((c) => c.path === '/agent/v1/decommission')).toBe(false);
  });

  it('does nothing when denied, expired or answered by anyone but the owner', async () => {
    env.svc.useAuthzSigner(signer());
    const fake = await env.enroll();
    let req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false });
    await answer(req.approvalId!, 'deny_continue');
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!.status).toBe('denied');
    req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false });
    await answer(req.approvalId!, 'allow_once', 'system');
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!.status).toBe('expired');
    // An unanswered card expires after its TTL; a new request may follow.
    req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false });
    env.clock.now += DECOMMISSION_APPROVAL_TTL_MS + 1;
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!.status).toBe('expired');
    await answer(req.approvalId!, 'allow_once');
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).status).not.toBe('revoked');
    expect(
      (await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false })).status,
    ).toBe('awaiting_approval');
    expect(fake.decommissioned).toBeNull();
    // Another account cannot see or start one.
    await expect(env.svc.decommission(OTHER, fake.deviceId!)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('is withdrawn (cancelled) when its card is withdrawn or the device is revoked meanwhile', async () => {
    env.svc.useAuthzSigner(signer());
    const fake = await env.enroll();
    // A Hub restart cancels every waiting card (the approvals store's recovery).
    let req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false });
    env.db.raw.prepare("UPDATE approval SET status = 'cancelled' WHERE id = ?").run(req.approvalId);
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!.status).toBe('cancelled');
    // Revoked by its own route while a request waits: the request and its card are withdrawn,
    // and a late "Allow once" changes nothing.
    req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: true });
    await env.svc.revoke(ACCOUNT, fake.deviceId!, { actor: 'user' });
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!).toMatchObject({
      status: 'cancelled',
      deviceResult: null,
    });
    expect(
      env.db.raw.prepare('SELECT status FROM approval WHERE id = ?').get(req.approvalId),
    ).toEqual({ status: 'cancelled' });
    expect(
      env.events.events.find(
        (e) => e.name === 'approval.cancelled' && e.payload.approvalId === req.approvalId,
      )?.payload,
    ).toEqual({ approvalId: req.approvalId, reason: 'device_revoked' });
    expect(
      env.audit.find((a) => a.action === 'device.decommission.decide' && a.decision === 'cancelled')
        ?.detail,
    ).toEqual({ decommissionId: req.id, approvalId: req.approvalId });
    await env.svc.onApprovalDecided(ACCOUNT, req.approvalId!, 'allow_once');
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!.status).toBe('cancelled');
    expect(fake.decommissioned).toBeNull();
    expect(fake.calls.some((c) => c.path === '/agent/v1/decommission')).toBe(false);
  });

  it('finishes after a restart', async () => {
    env.svc.useAuthzSigner(signer());
    const fake = await env.enroll();
    const req = await env.svc.requestDecommission(ACCOUNT, fake.deviceId!, { purge: false });
    // Approved while the Hub was down (the event never reached the area).
    env.db.raw
      .prepare(
        "UPDATE approval SET status = 'decided', decision = 'allow_once', decided_by = 'user' WHERE id = ?",
      )
      .run(req.approvalId);
    await env.svc.recoverDecommissions();
    expect((await env.svc.decommission(ACCOUNT, fake.deviceId!))!.status).toBe('done');
    // A run cut short is finished as revoked.
    const other = await env.enroll();
    const r2 = await env.svc.requestDecommission(ACCOUNT, other.deviceId!, { purge: false });
    env.db.raw.prepare("UPDATE device_decommission SET status = 'running' WHERE id = ?").run(r2.id);
    await env.svc.recoverDecommissions();
    expect((await env.svc.get(ACCOUNT, other.deviceId!)).status).toBe('revoked');
    expect((await env.svc.decommission(ACCOUNT, other.deviceId!))!.status).toBe('done');
  });
});

describe('managed services, available updates and owner overrides', () => {
  it('lists the declared services', async () => {
    const plain = await env.enroll({ modules: ['management', 'storage'] });
    expect(await env.svc.services(ACCOUNT, plain.deviceId!)).toEqual([]);
    const compute = await env.enroll({ modules: ['management', 'storage', 'compute'] });
    expect(await env.svc.services(ACCOUNT, compute.deviceId!)).toEqual([
      { name: 'compute', kind: 'module', state: 'running', module: 'compute', unit: null },
    ]);
  });

  it('turns a 404 from the device into update_required', async () => {
    const fake = await env.enroll();
    await fake.close();
    // A server that knows no `/agent/v1/services`.
    const { createServer: plain } = await import('node:http');
    const s = plain((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'unknown route' } }));
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    env.db.raw
      .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
      .run(`http://127.0.0.1:${(s.address() as { port: number }).port}`, fake.deviceId);
    const err = await rejects(env.svc.services(ACCOUNT, fake.deviceId!));
    expect(err.code).toBe('capability_missing');
    expect(err.details).toMatchObject({ reason: 'update_required' });
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('compares the device with the novad builds the Hub serves', async () => {
    const fake = await env.enroll({ novadVersion: '0.6.0' });
    expect(await env.svc.availableUpdates(ACCOUNT, fake.deviceId!)).toMatchObject({
      newer: false,
      reason: 'no_builds',
      platform: { os: 'linux', arch: 'amd64' },
    });
    const build = {
      name: 'novad-linux-amd64',
      os: 'linux',
      arch: 'amd64',
      sha256: 'a'.repeat(64),
      size: 10,
    };
    env.svc.useAvailableBuilds(() => Promise.resolve({ version: '0.7.5', files: [build] }));
    expect(await env.svc.availableUpdates(ACCOUNT, fake.deviceId!)).toMatchObject({
      current: { novad: '0.6.0' },
      novad: { version: '0.7.5', file: 'novad-linux-amd64' },
      newer: true,
      reason: 'newer_available',
    });
    env.svc.useAvailableBuilds(() => Promise.resolve({ version: '0.6.0', files: [build] }));
    expect((await env.svc.availableUpdates(ACCOUNT, fake.deviceId!)).reason).toBe('up_to_date');
    env.svc.useAvailableBuilds(() =>
      Promise.resolve({ version: '0.7.5', files: [{ ...build, arch: 'arm64' }] }),
    );
    expect((await env.svc.availableUpdates(ACCOUNT, fake.deviceId!)).reason).toBe(
      'no_build_for_platform',
    );
  });

  it('shows the overrides, what is in force, and pushes them on request', async () => {
    const fake = await env.enroll();
    await fake.close(); // unreachable for the PATCH push: it waits
    await env.svc.update(ACCOUNT, fake.deviceId!, {
      capabilityOverrides: { scheduling: { quietHours: ['22:00-07:00'] } },
      policy: { routingEligible: false },
    });
    let view = await env.svc.overrides(ACCOUNT, fake.deviceId!);
    expect(view).toMatchObject({
      capabilityOverrides: { scheduling: { quietHours: ['22:00-07:00'] } },
      policy: { routingEligible: false },
      configPending: true,
    });
    expect(view.effective.scheduling).toBeUndefined();
    await fake.listen();
    env.db.raw
      .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
      .run(fake.endpoint, fake.deviceId);
    view = await env.svc.pushOverrides(ACCOUNT, fake.deviceId!);
    expect(view.configPending).toBe(false);
    expect(view.effective.scheduling).toEqual({ quietHours: ['22:00-07:00'] });
    expect(env.audit.map((a) => a.action)).toContain('device.config.push');
  });
});

describe('for other areas: calls and heartbeat events', () => {
  it('calls a device over its channel and refuses what it cannot reach', async () => {
    const fake = await env.enroll();
    expect(
      await env.svc.call<{ deviceId: string }>(ACCOUNT, fake.deviceId!, '/agent/v1/status', {}),
    ).toMatchObject({ deviceId: fake.deviceId });
    await expect(env.svc.call(ACCOUNT, fake.deviceId!, '/api/v1/x', {})).rejects.toMatchObject({
      code: 'validation',
    });
    await toHttps(fake);
    expect(
      await env.svc.call<{ deviceId: string }>(ACCOUNT, fake.deviceId!, '/agent/v1/status', {}),
    ).toMatchObject({ deviceId: fake.deviceId });
    await env.svc.revoke(ACCOUNT, fake.deviceId!);
    await expect(
      env.svc.call(ACCOUNT, fake.deviceId!, '/agent/v1/status', {}),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('hands each heartbeat’s events to the listeners; a failing one changes nothing', async () => {
    const fake = await env.enroll();
    const seen: unknown[] = [];
    const off = env.svc.onHeartbeatEvents((accountId, deviceId, events) => {
      seen.push({ accountId, deviceId, events });
    });
    env.svc.onHeartbeatEvents(() => {
      throw new Error('boom');
    });
    fake.events.push({ kind: 'firmware.watchdog.ok', snapshotId: 's1' });
    expect((await fake.heartbeat()).status).toBe(200);
    expect(seen).toEqual([
      {
        accountId: ACCOUNT,
        deviceId: fake.deviceId,
        events: [{ kind: 'firmware.watchdog.ok', snapshotId: 's1' }],
      },
    ]);
    // No events, no call.
    await fake.heartbeat();
    expect(seen).toHaveLength(1);
    off();
    fake.events.push({ kind: 'boot.watchdog.ok' });
    await fake.heartbeat();
    expect(seen).toHaveLength(1);
  });
});

describe('device certificate renewal (D1)', () => {
  /** A certificate as M7 issued them (clientAuth only), recorded like one. */
  async function legacyCertificate(deviceId: string, publicKey: string): Promise<string> {
    const ca = env.db.raw
      .prepare('SELECT id, cert_pem, key_ref FROM trust_ca WHERE retired_at IS NULL')
      .get() as { id: string; cert_pem: string; key_ref: string };
    const caKey = createPrivateKey((await env.secrets.get(ca.key_ref))!);
    const cn = new X509Certificate(ca.cert_pem).subject
      .split('\n')
      .find((l) => l.startsWith('CN='))!
      .slice(3);
    const now = Date.now();
    const cert = buildCertificate({
      subject: { commonName: deviceId, organizationalUnit: 'client' },
      issuer: { commonName: cn },
      publicKey: ed25519FromRaw(publicKey),
      signer: caKey,
      issuerKeyId: keyId(createPublicKey(caKey)),
      notBefore: new Date(Math.floor(now / 1000) * 1000 - 3_600_000),
      notAfter: new Date(Math.floor(now / 1000) * 1000 + 300 * 86_400_000),
      keyUsage: 0x80,
      extKeyUsage: [CLIENT_AUTH],
      altNames: { uris: [`urn:nova:device:${deviceId}`] },
    });
    const x = new X509Certificate(cert.pem);
    env.db.raw
      .prepare(
        `INSERT INTO trust_certificate (id, ca_id, kind, serial, subject, device_id, role, sans_json,
           public_key, cert_pem, not_before, not_after, created_at)
         VALUES (?, ?, 'device', ?, ?, ?, 'client', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        ca.id,
        cert.serial,
        deviceId,
        deviceId,
        JSON.stringify([`urn:nova:device:${deviceId}`]),
        publicKey,
        cert.pem,
        new Date(x.validFrom).toISOString(),
        new Date(x.validTo).toISOString(),
        new Date(now - 60_000).toISOString(),
      );
    return cert.pem;
  }

  const fullTls = (graceMs?: number): DeviceTlsTrust => ({
    ...tlsOf(trust),
    allowLegacyServerCertificate: (id, pem) =>
      trust.legacyServerCertificateAllowed(id, pem, graceMs),
    presented: (id, serial) => trust.deviceCertificatePresented(id, serial),
    certificateState: (id) => trust.deviceCertificateState(id, graceMs),
  });

  const channelOf = async (id: string) =>
    (await env.svc.managementTls(ACCOUNT)).items.find((i) => i.deviceId === id)!;

  it('renews a pre-M7.5 certificate; the old one serves the channel only until then', async () => {
    const fake = await env.enroll();
    const id = fake.deviceId!;
    const legacy = await legacyCertificate(id, fake.publicKey);
    env.svc.useManagementTls(fullTls());
    env.svc.useCertificateRenewal((d, key) => trust.deviceCertificateRenewal(d, key));
    // Not offered yet: the next check-in brings it.
    expect(await channelOf(id)).toMatchObject({
      renewal: { state: 'none', offeredAt: null, notAfter: null, reason: null },
      legacyCertificate: true,
      legacyGraceEndsAt: null,
    });
    const caPem = trust.caCertificate()!;
    const url = await fake.listenTls({ certPem: legacy, caPem });
    const hb = await fake.heartbeat({ endpoint: url });
    expect(hb.status).toBe(200);
    const renewed = hb.json.certificate as { pem: string; notAfter: string };
    const x = new X509Certificate(renewed.pem);
    expect(x.keyUsage?.sort()).toEqual([CLIENT_AUTH, SERVER_AUTH].sort());
    expect(x.subjectAltName).toBe(`URI:urn:nova:device:${id}`);
    expect(rawEd25519(x.publicKey).toString('base64url')).toBe(fake.publicKey);
    const offered = await channelOf(id);
    expect(offered).toMatchObject({
      renewal: { state: 'offered', notAfter: renewed.notAfter, reason: 'missing_server_auth' },
      legacyCertificate: true,
    });
    expect(Date.parse(offered.legacyGraceEndsAt!) - Date.parse(offered.renewal!.offeredAt!)).toBe(
      10 * 60_000,
    );
    // Until the device installs it, the old certificate still serves (checked by the Hub itself).
    expect(
      await env.svc.call<{ deviceId: string }>(ACCOUNT, id, '/agent/v1/status', {}),
    ).toMatchObject({ deviceId: id });
    // The same renewal again with the next answer, not another one.
    expect((await fake.heartbeat()).json.certificate).toEqual(renewed);
    // Past the grace the old certificate is refused; without the allowance it always is.
    env.svc.useManagementTls(fullTls(0));
    let err = await rejects(env.svc.call(ACCOUNT, id, '/agent/v1/status', {}));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'unsupported_purpose' });
    const clockWas = env.clock.now;
    env.clock.now = Date.now() + 60_000;
    expect((await env.svc.managementTls(ACCOUNT)).problems.join(' ')).toContain(
      'has not installed its renewed certificate',
    );
    env.clock.now = clockWas;
    env.svc.useManagementTls(tlsOf(trust));
    err = await rejects(env.svc.call(ACCOUNT, id, '/agent/v1/status', {}));
    expect(err.details).toEqual({ reason: 'device_tls_failed', tls: 'unsupported_purpose' });
    // The device installs the renewal: presenting it revokes the old one.
    env.svc.useManagementTls(fullTls());
    const url2 = await fake.listenTls({ certPem: renewed.pem, caPem });
    await fake.heartbeat({ endpoint: url2 });
    expect(
      await env.svc.call<{ deviceId: string }>(ACCOUNT, id, '/agent/v1/status', {}),
    ).toMatchObject({ deviceId: id });
    expect(trust.verifyDeviceCertificate(legacy)).toEqual({ ok: false, reason: 'revoked' });
    expect(await channelOf(id)).toMatchObject({
      renewal: { state: 'presented', notAfter: renewed.notAfter, reason: 'missing_server_auth' },
      legacyCertificate: false,
      legacyGraceEndsAt: null,
    });
    expect((await fake.heartbeat()).json.certificate).toBeUndefined();
    expect(trust.legacyServerCertificateAllowed(id, legacy)).toBe(false);
    // A serverAuth certificate or another device's never takes the legacy path.
    expect(trust.legacyServerCertificateAllowed(id, renewed.pem)).toBe(false);
    expect(trust.legacyServerCertificateAllowed('someone', renewed.pem)).toBe(false);
  });

  it('renews in the last third of a certificate’s life, once', async () => {
    const clock = { t: Date.now() };
    const t2 = new TrustService({
      db: env.db,
      secrets: env.secrets,
      settings: {
        mode: () => Promise.resolve('local-ca'),
        meshCerts: () => Promise.resolve(false),
        pinNativeShells: () => Promise.resolve(true),
      },
      names: () => Promise.resolve([]),
      now: () => new Date(clock.t),
    });
    const key = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    const first = (await t2.issueDeviceCertificate({
      deviceId: 'dev-x',
      publicKey: key,
      role: 'client',
    }))!;
    expect(await t2.deviceCertificateRenewal('dev-x', key)).toBeNull();
    expect(await t2.deviceCertificateRenewal('dev-x', 'another-key')).toBeNull();
    expect(t2.deviceCertificateState('dev-x').renewal?.state).toBe('none');
    expect(t2.deviceCertificateState('nobody')).toEqual({
      renewal: null,
      legacyCertificate: false,
      legacyGraceEndsAt: null,
    });
    clock.t += 250 * 86_400_000;
    const renewal = (await t2.deviceCertificateRenewal('dev-x', key))!;
    expect(t2.deviceCertificateState('dev-x')).toMatchObject({
      renewal: { state: 'offered', reason: 'expiring' },
      legacyCertificate: false,
      legacyGraceEndsAt: null,
    });
    expect(renewal.serial).not.toBe(first.serial);
    expect((await t2.deviceCertificateRenewal('dev-x', key))!.serial).toBe(renewal.serial);
    // Seeing the old one again changes nothing; seeing the new one revokes the old.
    expect(await t2.deviceCertificatePresented('dev-x', first.serial)).toBe(0);
    expect(await t2.deviceCertificatePresented('dev-x', renewal.serial)).toBe(1);
    expect(t2.deviceCertificateState('dev-x').renewal).toMatchObject({
      state: 'presented',
      reason: 'expiring',
    });
    expect(await t2.deviceCertificatePresented('dev-x', 'ffff')).toBe(0);
    expect(await t2.deviceCertificateRenewal('dev-x', key)).toBeNull();
  });
});
