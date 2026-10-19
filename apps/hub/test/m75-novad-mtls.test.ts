// M7.5 through the fully wired Hub (app.ts) in local-CA trust mode with the real `novad` binary
// (ADR-096 D1, D2, D3; FR-126, FR-146, R-022): novad installs over https:// with its pin and holds
// a device certificate; it registers an https:// management endpoint, which the Hub then calls
// over mutual TLS only (its client certificate, novad's certificate checked by chain, URI SAN and
// pinned key); the toggle push reaches novad through `/agent/v1/config`; a firmware apply with a
// Hub-signed authorization runs end to end against novad's fake firmware backend; novad refuses a
// client without a certificate and the Hub never moves the device back to plain HTTP; and an
// M7-style certificate (clientAuth only) is renewed through the heartbeat and then used. Runs when
// the binary is built (`node scripts/cargo.mjs build`; or NOVA_NOVAD_BIN).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type DeviceManagementTlsSummaryView } from '@nova/shared';
import { buildCertificate, ed25519FromRaw } from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { tlsListener } from '../src/main.ts';

const BIN =
  process.env.NOVA_NOVAD_BIN ??
  resolve(import.meta.dirname, '../../../services/novad/target/debug/novad');
const runnable =
  existsSync(BIN) &&
  // A build with the management channel over mutual TLS (M7.5).
  spawnSync(BIN, ['help'], { encoding: 'utf8' }).stdout.includes('http(s)://') &&
  readFileSync(BIN).includes('urn:nova:hub:') &&
  process.platform === 'linux' &&
  (process.arch === 'x64' || process.arch === 'arm64');
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

let dir: string;
let db: NovaDatabase;
let secrets: MemorySecretStore;
let hub: Hub;
let hubUrl: string;
let headers: Record<string, string>;
let listener: Awaited<ReturnType<typeof tlsListener>> | null = null;
let run: ChildProcess | null = null;
let out = '';
const savedDist = process.env.NOVA_NOVAD_DIST;

// What the first test leaves for the second.
let data = '';
let deviceId = '';
let endpoint = '';

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; novad said:\n${out.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const api = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const res = await hub.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Json }),
  });
  return { status: res.statusCode, json: res.json<Json>() };
};

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function startNovad(): void {
  out = '';
  run = spawn(BIN, ['run', '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  run.stdout!.on('data', (c: Buffer) => (out += c.toString()));
  run.stderr!.on('data', (c: Buffer) => (out += c.toString()));
}

async function stopNovad(): Promise<void> {
  const child = run;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.on('close', () => r()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const channel = async () =>
  (
    (await api('GET', '/api/v1/devices/management-tls'))
      .json as unknown as DeviceManagementTlsSummaryView
  ).items.find((i) => i.deviceId === deviceId)!;

const firmwareFile = () => join(dir, 'firmware.json');
const wol = () =>
  (JSON.parse(readFileSync(firmwareFile(), 'utf8')) as Json).settings.wol.value as string;

/** An HTTPS request to the device's management endpoint as an arbitrary client. */
function rawCall(opts: { cert?: string; key?: string }): Promise<number> {
  const u = new URL(endpoint);
  return new Promise((res, rej) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: '/agent/v1/status',
        method: 'POST',
        agent: false,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        headers: { 'content-type': 'application/json' },
        ...(opts.cert ? { cert: opts.cert, key: opts.key } : {}),
      },
      (r) => {
        r.resume();
        r.on('end', () => res(r.statusCode ?? 0));
      },
    );
    req.on('error', rej);
    req.end('{}');
  });
}

// CI sets NOVA_REQUIRE_NOVAD=1 so a missing or outdated binary fails the run instead of
// skipping these tests unnoticed.
it.runIf(process.env.NOVA_REQUIRE_NOVAD === '1')('has a runnable novad binary', () => {
  expect(runnable, BIN).toBe(true);
});

describe.skipIf(!runnable)('the management channel to the real novad over mutual TLS', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-hub-m75mtls-'));
    const dist = join(dir, 'dist');
    mkdirSync(dist);
    copyFileSync(BIN, join(dist, `novad-linux-${ARCH}`));
    process.env.NOVA_NOVAD_DIST = dist;
    const config = loadConfig(
      { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
      [],
    );
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    db.raw
      .prepare(
        "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES ('trust.mode', 'global', '', '\"local-ca\"', ?)",
      )
      .run(new Date().toISOString());
    secrets = new MemorySecretStore();
    const mock = new MockProvider({ id: 'mock', timing: 'instant' });
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets,
      providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
      chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    });
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { host: '127.0.0.1:7419' },
      payload: { code, displayName: 'Owner' },
    });
    const session = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    headers = { host: '127.0.0.1:7419', authorization: `Bearer ${session}` };
    const material = await hub.trust.tls.material();
    listener = await tlsListener(hub.app, {
      ...material!,
      clientCa: hub.trust.service.caCertificate(),
    });
    const port = await listener.listen(0, '127.0.0.1');
    hubUrl = `https://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (savedDist === undefined) delete process.env.NOVA_NOVAD_DIST;
    else process.env.NOVA_NOVAD_DIST = savedDist;
    await stopNovad();
    await listener?.close();
    await hub?.app.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('is called over mutual TLS only: services, the policy push, a signed firmware apply', async () => {
    // ---- install over https with the pin; Add Device grants the certificate ----------------
    const fingerprint = (await api('GET', '/api/v1/hello')).json.hubFingerprint as string;
    const start = await api('POST', '/api/v1/devices/add/start', { role: 'client' });
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    const { pairingId, code } = start.json as { pairingId: string; code: string };
    data = join(dir, 'novad');
    const listen = await freePort();
    const child = spawn(
      BIN,
      [
        'install',
        '--hub',
        hubUrl,
        '--code',
        '-',
        '--pairing',
        pairingId,
        '--pin',
        fingerprint,
        '--role',
        'client',
        '--name',
        'desk',
        '--listen',
        `127.0.0.1:${listen}`,
        '--no-service',
        '--data-dir',
        data,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin.end(`${code}\n`);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    try {
      await until(() => Promise.resolve(/Confirm this code on the Hub: \d{3} \d{3}/.test(stdout)));
      const pending = await until(async () => {
        const r = await api('GET', '/api/v1/devices/add/requests');
        return (r.json.items as { id: string; confirmation: string }[])[0];
      });
      const ok = await api('POST', `/api/v1/devices/add/requests/${pending.id}/approve`, {
        confirmation: pending.confirmation,
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(await exited, stderr + stdout).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    expect(existsSync(join(data, 'device-cert.pem'))).toBe(true);
    const device = (
      (await api('GET', '/api/v1/devices/novad')).json.items as { id: string; name: string }[]
    ).find((d) => d.name === 'desk')!;
    deviceId = device.id;

    // 1. novad registered an https management endpoint.
    endpoint = (await api('GET', `/api/v1/devices/${deviceId}`)).json.endpoint as string;
    expect(endpoint).toBe(`https://127.0.0.1:${listen}`);

    // The fake firmware backend novad offers for tests (config.json), then `novad run`.
    writeFileSync(
      firmwareFile(),
      JSON.stringify({
        platform: {
          vendor: 'Nova Labs',
          product: 'Test PC',
          biosVendor: 'Nova',
          biosVersion: '1.0',
          biosDate: '2026-09-01',
          uefi: true,
        },
        adminPasswordSet: false,
        requiresReboot: true,
        settings: {
          wol: {
            vendorKey: 'WakeOnLan',
            value: 'Disabled',
            type: 'enum',
            allowed: ['Disabled', 'Enabled'],
          },
        },
        failWrites: [],
      }),
    );
    const configPath = join(data, 'config.json');
    const cfg = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, 'utf8')) as Json)
      : {};
    writeFileSync(
      configPath,
      JSON.stringify({ ...cfg, firmware: { backend: 'fake', fakePath: firmwareFile() } }),
    );
    startNovad();
    await until(
      async () => (await api('GET', `/api/v1/devices/${deviceId}`)).json.status === 'active',
    );

    // 2. A route that calls the device succeeds over mutual TLS; the view says so.
    const services = await until(async () => {
      const r = await api('GET', `/api/v1/devices/${deviceId}/services`);
      return r.status === 200 ? r : null;
    });
    expect(Array.isArray(services.json.items)).toBe(true);
    expect(await channel()).toMatchObject({
      endpoint,
      channel: 'mutual_tls',
      lastCall: { ok: true, failure: null },
      legacyCertificate: false,
    });
    const tlsView = await api('GET', '/api/v1/devices/management-tls');
    expect(tlsView.json.hubClient.uri).toBe(`urn:nova:hub:${fingerprint}`);

    // 3. Turning firmware changes on reaches novad at once through /agent/v1/config.
    const on = await api('PUT', '/api/v1/devices/firmware/policy', {
      allowChanges: true,
      confirm: true,
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    await until(() => {
      const path = join(data, 'policy.json');
      if (!existsSync(path)) return Promise.resolve(false);
      return Promise.resolve(
        (JSON.parse(readFileSync(path, 'utf8')) as Json).firmwareChanges === true,
      );
    }, 5_000);

    // 4. A firmware apply with the Hub-signed authorization, end to end over mutual TLS.
    const base = `/api/v1/devices/${deviceId}/firmware`;
    const read = await api('GET', base);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(read.json).toMatchObject({ supported: true });
    const plan = await api('POST', `${base}/plan`, { changes: [{ key: 'wol', value: 'Enabled' }] });
    expect(plan.status, JSON.stringify(plan.json)).toBe(201);
    const changeId = plan.json.id as string;
    const asked = await api('POST', `${base}/changes/${changeId}/request-approval`, {});
    expect(asked.status, JSON.stringify(asked.json)).toBeLessThan(300);
    const decided = await api('POST', '/api/v1/approvals', {
      approvalId: asked.json.approval.id as string,
      decision: 'allow_once',
    });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    await until(
      async () => (await api('GET', `${base}/changes/${changeId}`)).json.status === 'approved',
    );
    const applied = await api('POST', `${base}/changes/${changeId}/apply`, {});
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json.status).toBe('applied');
    expect(wol()).toBe('Enabled');
    expect((await channel()).lastCall).toMatchObject({ ok: true });

    // 5. novad refuses a client without a certificate, and one from another CA's key.
    await expect(rawCall({})).rejects.toThrow();
    // Plain HTTP to the same port is not served either.
    await expect(
      fetch(`http://127.0.0.1:${listen}/agent/v1/status`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
    // The Hub never moves the device back to plain HTTP: a heartbeat offering it is refused.
    const credential = (JSON.parse(readFileSync(join(data, 'device.json'), 'utf8')) as Json)
      .credential as string;
    const down = await hub.app.inject({
      method: 'POST',
      url: '/agent/v1/heartbeat',
      headers: { authorization: `Bearer ${credential}` },
      payload: { novadVersion: '0.7.0', endpoint: `http://127.0.0.1:${listen}` },
    });
    expect(down.statusCode).toBe(403);
    expect(down.json<Json>().error.details).toEqual({ reason: 'endpoint_downgrade' });
    expect((await api('GET', `/api/v1/devices/${deviceId}`)).json.endpoint).toBe(endpoint);
  }, 180_000);

  it('renews an M7-style certificate through the heartbeat, then uses it', async () => {
    expect(deviceId).not.toBe('');
    await stopNovad();
    // Replace the device's certificate with one as M7 issued them: clientAuth only, recorded by
    // the Hub, the install certificate revoked.
    const ca = db.raw
      .prepare('SELECT id, cert_pem, key_ref FROM trust_ca WHERE retired_at IS NULL')
      .get() as { id: string; cert_pem: string; key_ref: string };
    const caKey = createPrivateKey((await secrets.get(ca.key_ref))!);
    const cn = new X509Certificate(ca.cert_pem).subject
      .split('\n')
      .find((l) => l.startsWith('CN='))!
      .slice(3);
    const row = db.raw.prepare('SELECT public_key FROM device WHERE id = ?').get(deviceId) as {
      public_key: string;
    };
    const now = Math.floor(Date.now() / 1000) * 1000;
    const legacy = buildCertificate({
      subject: { commonName: deviceId, organizationalUnit: 'client' },
      issuer: { commonName: cn },
      publicKey: ed25519FromRaw(row.public_key),
      signer: caKey,
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 300 * 86_400_000),
      keyUsage: 0x80,
      extKeyUsage: [CLIENT_AUTH],
      altNames: { uris: [`urn:nova:device:${deviceId}`] },
    });
    const x = new X509Certificate(legacy.pem);
    db.raw
      .prepare(
        `UPDATE trust_certificate SET revoked_at = ?, revoked_reason = 'test'
         WHERE kind = 'device' AND device_id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), deviceId);
    db.raw
      .prepare(
        `INSERT INTO trust_certificate (id, ca_id, kind, serial, subject, device_id, role, sans_json,
           public_key, cert_pem, not_before, not_after, created_at)
         VALUES (?, ?, 'device', ?, ?, ?, 'client', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        ca.id,
        legacy.serial,
        deviceId,
        deviceId,
        JSON.stringify([`urn:nova:device:${deviceId}`]),
        row.public_key,
        legacy.pem,
        new Date(x.validFrom).toISOString(),
        new Date(x.validTo).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
      );
    const certPath = join(data, 'device-cert.pem');
    writeFileSync(certPath, legacy.pem);
    chmodSync(certPath, 0o600);
    expect((await channel()).legacyCertificate).toBe(true);

    // The next heartbeat answer carries a renewal; novad installs it.
    startNovad();
    const renewed = await until(() => {
      const pem = readFileSync(certPath, 'utf8');
      return Promise.resolve(pem !== legacy.pem ? new X509Certificate(pem) : null);
    });
    expect(renewed.keyUsage?.sort()).toEqual([CLIENT_AUTH, SERVER_AUTH].sort());
    expect(renewed.subjectAltName).toBe(`URI:urn:nova:device:${deviceId}`);
    expect((await channel()).renewal).toMatchObject({
      state: 'offered',
      reason: 'missing_server_auth',
    });

    // A call over mutual TLS sees the renewed certificate: the old one is revoked.
    await until(async () => {
      const r = await api('GET', `/api/v1/devices/${deviceId}/services`);
      return r.status === 200;
    });
    await until(async () => (await channel()).renewal?.state === 'presented');
    expect(await channel()).toMatchObject({
      channel: 'mutual_tls',
      legacyCertificate: false,
      lastCall: { ok: true },
    });
    expect(hub.trust.verifyDeviceCertificate(legacy.pem)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  }, 120_000);
});
