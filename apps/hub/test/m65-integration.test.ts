// M6.5 through the fully wired Hub (app.ts) on a real port: the real `novad` binary installs
// itself from this Hub's signed dist folder (FR-133) and joins with Add Device v2 (FR-132): it
// checks the pinned Hub identity and the signed manifest, commits, reveals, prints the
// confirmation, and the owner approves by typing the code novad shows; novad then registers with
// the granted token and its capabilities are listed (docs/17 §M6.5 exit criteria). The QR and the
// install command carry the pairing id and the Hub's fingerprint. Runs when the binary is built
// (`node scripts/cargo.mjs build`; or NOVA_NOVAD_BIN).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const BIN =
  process.env.NOVA_NOVAD_BIN ??
  resolve(import.meta.dirname, '../../../services/novad/target/debug/novad');
const runnable =
  existsSync(BIN) &&
  spawnSync(BIN, ['help'], { encoding: 'utf8' }).stdout.includes('--pairing') &&
  (process.platform === 'linux' || process.platform === 'darwin') &&
  (process.arch === 'x64' || process.arch === 'arm64');
const OS = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

type Json = Record<string, unknown>;

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let hubUrl: string;
let headers: Record<string, string>;
const savedDist = process.env.NOVA_NOVAD_DIST;

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
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

describe.skipIf(!runnable)('novad joins the fully wired Hub', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-hub-m65-'));
    // The Hub serves the builds in its dist folder (packaging fills it; here the test build).
    const dist = join(dir, 'dist');
    mkdirSync(dist);
    copyFileSync(BIN, join(dist, `novad-${OS}-${ARCH}`));
    process.env.NOVA_NOVAD_DIST = dist;
    const config = loadConfig(
      { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
      [],
    );
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const mock = new MockProvider({ id: 'mock', timing: 'instant' });
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets: new MemorySecretStore(),
      providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
      chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    });
    hubUrl = await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { host: '127.0.0.1:7419' },
      payload: { code, displayName: 'Owner' },
    });
    const session = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    headers = { host: '127.0.0.1:7419', authorization: `Bearer ${session}` };
  });

  afterAll(async () => {
    if (savedDist === undefined) delete process.env.NOVA_NOVAD_DIST;
    else process.env.NOVA_NOVAD_DIST = savedDist;
    await hub?.app.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('installs from the signed dist, is approved with the code it shows, and registers', async () => {
    // The Hub publishes its identity; the manifest lists the build, signed by that identity.
    const hello = await hub.app.inject({ method: 'GET', url: '/api/v1/hello', headers });
    const fingerprint = hello.json<{ hubFingerprint: string }>().hubFingerprint;
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const manifest = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/agent/dist/novad-manifest.json',
      headers,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json<{ files: { name: string }[] }>().files.map((f) => f.name)).toContain(
      `novad-${OS}-${ARCH}`,
    );

    // The owner starts Add Device for a compute node: the QR carries the pairing id and the pin.
    const start = await api('POST', '/api/v1/devices/add/start', { role: 'compute' });
    expect(start.status, JSON.stringify(start.json)).toBe(201);
    const { pairingId, code, qr } = start.json as { pairingId: string; code: string; qr: string };
    expect(qr).toContain(`p=${pairingId}`);
    expect(qr).toContain(`fp=${fingerprint}`);
    expect(qr).not.toContain(`?c=`);
    // A loopback Hub address cannot reach another machine: no command, with the reason.
    const bootstrap = start.json.bootstrap as { command: string | null; why: string | null };
    expect(bootstrap.command).toBeNull();
    expect(bootstrap.why).toBeTruthy();

    // novad install, as the one-line command runs it (the code on standard input).
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
        'compute',
        '--name',
        'build-box',
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
      const digits = `${shown[1]}${shown[2]}`;
      expect(stdout).toContain(`Hub identity verified: ${fingerprint}`);

      // The owner sees the request (only after the reveal) with the same code.
      const pending = await until(async () => {
        const r = await api('GET', '/api/v1/devices/add/requests');
        return (r.json.items as { id: string; confirmation: string; kind: string }[])[0];
      });
      expect(pending.confirmation).toBe(digits);
      expect(pending.kind).toBe('novad');
      // A wrong code is refused; the right one approves.
      const wrong = await api('POST', `/api/v1/devices/add/requests/${pending.id}/approve`, {
        confirmation: digits === '000000' ? '111111' : '000000',
      });
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      const ok = await api('POST', `/api/v1/devices/add/requests/${pending.id}/approve`, {
        confirmation: digits,
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);

      expect(await exited, stderr + stdout).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    // It registered with the same key and reports a signed capability document.
    const all = await api('GET', '/api/v1/devices/all');
    const box = (all.json.items as { id: string; name: string; status: string }[]).find(
      (d) => d.name === 'build-box',
    );
    expect(box, JSON.stringify(all.json)).toBeDefined();
    const novad = await api('GET', '/api/v1/devices/novad');
    const device = (
      novad.json.items as { id: string; roles: string[]; capability: unknown }[]
    ).find((d) => d.id === box!.id);
    expect(device?.roles).toEqual(['compute']);
    expect(device?.capability).toBeTruthy();

    // The code is spent: a second install with it is refused before anything is written.
    const again = spawnSync(
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
        '--no-service',
        '--data-dir',
        join(dir, 'novad-again'),
      ],
      { input: `${code}\n`, encoding: 'utf8', timeout: 30_000 },
    );
    expect(again.status).not.toBe(0);
    expect(existsSync(join(dir, 'novad-again', 'device.json'))).toBe(false);
  }, 90_000);
});
