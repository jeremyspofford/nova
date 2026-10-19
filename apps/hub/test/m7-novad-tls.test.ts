// M7 through the fully wired Hub (app.ts) serving HTTPS from its local CA (FR-126, FR-134, R-022,
// R-023, FR-128): the real `novad` binary installs over https:// with only the pinned fingerprint
// (it checks the Hub's signed identity statement on the connection itself and learns the CA),
// presents the device certificate the approval granted from registration on, heartbeats over
// mutual TLS, keeps the scopes the owner grants for its local runtime, and is refused once its
// certificate is revoked. Runs when the binary is built (`node scripts/cargo.mjs build`; or
// NOVA_NOVAD_BIN).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSetting, type DeviceTlsSummaryView, type SettingKey } from '@nova/shared';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { setupDeviceTrust } from '../src/device-trust.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { tlsListener } from '../src/main.ts';

const BIN =
  process.env.NOVA_NOVAD_BIN ??
  resolve(import.meta.dirname, '../../../services/novad/target/debug/novad');
const runnable =
  existsSync(BIN) &&
  // A build with the TLS client (its help names https://).
  spawnSync(BIN, ['help'], { encoding: 'utf8' }).stdout.includes('http(s)://') &&
  process.platform === 'linux' &&
  (process.arch === 'x64' || process.arch === 'arm64');
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

type Json = Record<string, unknown>;

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let hubUrl: string;
let headers: Record<string, string>;
let listener: Awaited<ReturnType<typeof tlsListener>> | null = null;
let run: ChildProcess | null = null;
const savedDist = process.env.NOVA_NOVAD_DIST;

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
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

// CI sets NOVA_REQUIRE_NOVAD=1 so a missing or outdated binary fails the run instead of
// skipping these tests unnoticed.
it.runIf(process.env.NOVA_REQUIRE_NOVAD === '1')('has a runnable novad binary', () => {
  expect(runnable, BIN).toBe(true);
});

describe.skipIf(!runnable)('novad over mutual TLS with the fully wired Hub', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-hub-m7tls-'));
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
    // The owner chose the Hub local CA: the listener serves its leaf (FR-134).
    db.raw
      .prepare(
        "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES ('trust.mode', 'global', '', '\"local-ca\"', ?)",
      )
      .run(new Date().toISOString());
    const mock = new MockProvider({ id: 'mock', timing: 'instant' });
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets: new MemorySecretStore(),
      providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
      chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    });
    // The device-trust area, unless app.ts already wires it (before the app is ready).
    if (!hub.app.hasRoute({ method: 'GET', url: '/api/v1/devices/tls' })) {
      const setting = <K extends SettingKey>(key: K) => {
        const rows = db.raw
          .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
          .all() as { key: string; value_json: string }[];
        const global = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
        return Promise.resolve(resolveSetting(key, { global, managed: {} }).value);
      };
      const ctx = {
        db,
        events: hub.events,
        log: new Logger({ module: 'hub', sinks: [] }),
        setting,
        accountOf: async () => (await hub.auth.ownerAccount())!.id,
        diagnostics: new DiagnosticsRegistry(),
      } as unknown as HubContext;
      const area = await setupDeviceTrust(ctx, {
        verifyDeviceCertificate: (pem) => hub.trust.verifyDeviceCertificate(pem),
      });
      area.register(hub.app);
    }
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
    if (run && run.exitCode === null) run.kill('SIGKILL');
    await listener?.close();
    await hub?.app.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('installs over https with the pin, then heartbeats with its device certificate', async () => {
    const fingerprint = (await api('GET', '/api/v1/hello')).json.hubFingerprint as string;
    const start = await api('POST', '/api/v1/devices/add/start', { role: 'client' });
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    const { pairingId, code } = start.json as { pairingId: string; code: string };

    const data = join(dir, 'novad');
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
      const shown = await until(() =>
        Promise.resolve(/Confirm this code on the Hub: (\d{3}) (\d{3})/.exec(stdout)),
      );
      expect(stdout).toContain(`Hub identity verified: ${fingerprint}`);
      const pending = await until(async () => {
        const r = await api('GET', '/api/v1/devices/add/requests');
        return (r.json.items as { id: string; confirmation: string }[])[0];
      });
      expect(pending.confirmation).toBe(`${shown[1]}${shown[2]}`);
      const ok = await api('POST', `/api/v1/devices/add/requests/${pending.id}/approve`, {
        confirmation: pending.confirmation,
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(await exited, stderr + stdout).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    // It kept the granted certificate and learned the Hub local CA from the signed statement.
    const ca = hub.trust.service.caCertificate()!;
    const cert = new X509Certificate(readFileSync(join(data, 'device-cert.pem'), 'utf8'));
    expect(cert.checkIssued(new X509Certificate(ca))).toBe(true);
    const learned = JSON.parse(readFileSync(join(data, 'hub-trust.json'), 'utf8')) as {
      pin: string;
      caPem: string;
    };
    expect(learned.pin).toBe(fingerprint);
    expect(new X509Certificate(learned.caPem).fingerprint256).toBe(
      new X509Certificate(ca).fingerprint256,
    );
    expect((statSync(join(data, 'hub-trust.json')).mode & 0o777).toString(8)).toBe('600');
    const device = (
      (await api('GET', '/api/v1/devices/novad')).json.items as { id: string; name: string }[]
    ).find((d) => d.name === 'desk')!;
    expect(device).toBeDefined();
    expect(cert.subject).toContain(`CN=${device.id}`);

    // `novad run`: heartbeats over https, presenting the certificate.
    let out = '';
    run = spawn(BIN, ['run', '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    run.stdout!.on('data', (c: Buffer) => (out += c.toString()));
    run.stderr!.on('data', (c: Buffer) => (out += c.toString()));
    const tls = async () =>
      (
        (await api('GET', '/api/v1/devices/tls')).json as unknown as DeviceTlsSummaryView
      ).items.find((i) => i.deviceId === device.id);
    const verified = await until(async () => {
      const s = await tls();
      return s?.certificate === 'verified' ? s : null;
    });
    expect(verified.serial).toBe(cert.serialNumber.toLowerCase());
    // The local runtime listens on its private socket, refusing until the Hub grants the scope.
    const sock = join(data, 'local-runtime', 'runtime.sock');
    await until(() => Promise.resolve(existsSync(sock)));
    expect((statSync(sock).mode & 0o777).toString(8)).toBe('600');

    // The owner grants Local models: the next heartbeat answer carries it (FR-128).
    const scoped = await api('PUT', `/api/v1/devices/${device.id}/scopes`, {
      scopes: ['local-runtime'],
    });
    expect(scoped.status, JSON.stringify(scoped.json)).toBe(200);
    await until(() => {
      const path = join(data, 'scopes.json');
      if (!existsSync(path)) return Promise.resolve(false);
      const s = JSON.parse(readFileSync(path, 'utf8')) as { scopes: string[] };
      return Promise.resolve(s.scopes.includes('local-runtime'));
    });

    // Revoking the certificate (device revocation does it too) refuses the next heartbeat.
    await hub.trust.revokeDevice(device.id);
    const refused = await until(async () => {
      const s = await tls();
      return s?.certificate === 'refused' ? s : null;
    });
    expect(refused.reason).toBe('certificate_revoked');
    await until(() => Promise.resolve(out.includes('certificate_revoked')));
    expect(out).toContain('refused this device over HTTPS');
  }, 120_000);
});
