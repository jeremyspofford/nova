// The real novad binary against the devices area (FR-141, FR-142, FR-145, FR-148, FR-210), when
// it is built (`npm run test:rust` or `node scripts/cargo.mjs build` leaves it in
// services/novad/target/debug; NOVA_NOVAD_BIN names another). It enrolls with a token, signs its
// document in Rust (the Hub verifies it in Node), runs its supervisor with module processes,
// serves file operations with staged writes and folder requests, restarts a killed module,
// applies a module update signed here and verified there, and stops when revoked.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import { canonicalJson } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const BIN =
  process.env.NOVA_NOVAD_BIN ??
  resolve(import.meta.dirname, '../../../services/novad/target/debug/novad');
const runnable = existsSync(BIN) && spawnSync(BIN, ['version']).status === 0;
const ACCOUNT = '01920000-0000-7000-8000-000000000001';

let db: NovaDatabase;
let events: EventStore;
let app: FastifyInstance;
let area: DevicesArea;
let hubUrl: string;
let dir: string;
let data: string;
let proj: string;
let novad: ChildProcess | null = null;
let deviceId: string;
const keys = generateKeyPairSync('ed25519');
const updateKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${hubUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    p.on('close', (status) => done({ status, stdout, stderr }));
  });
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// CI sets NOVA_REQUIRE_NOVAD=1 so a missing or outdated binary fails the run instead of
// skipping these tests unnoticed.
it.runIf(process.env.NOVA_REQUIRE_NOVAD === '1')('has a runnable novad binary', () => {
  expect(runnable, BIN).toBe(true);
});

describe.skipIf(!runnable)('the real novad binary', () => {
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nova-novad-')));
    data = join(dir, 'novad');
    proj = join(dir, 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'notes.md'), 'one\ntwo\n');
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const iso = new Date().toISOString();
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(ACCOUNT, iso, iso);
    events = new EventStore(db);
    const settings: Partial<Record<SettingKey, unknown>> = {
      'devices.minNovadVersions': {},
      'devices.wakesPerHour': 6,
    };
    const ctx = {
      db,
      secrets: new MemorySecretStore(),
      events,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      diagnostics: new DiagnosticsRegistry(),
      setting: (key: SettingKey) => Promise.resolve(settings[key]),
      accountOf: () => Promise.resolve(ACCOUNT),
    } as unknown as HubContext;
    area = await setupDevices(ctx, { heartbeatIntervalMs: 1_000 });
    app = Fastify({ bodyLimit: 1024 * 1024 });
    app.setErrorHandler((err, _req, reply) => {
      if (isNovaError(err))
        return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
      return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
    });
    area.register(app);
    hubUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client', 'compute'] });
    const listen = `127.0.0.1:${await freePort()}`;
    // Asynchronously: the Hub answering the enrollment runs in this process.
    const enrolled = await run([
      'enroll',
      '--hub',
      hubUrl,
      '--token',
      t.json.token as string,
      '--listen',
      listen,
      '--name',
      'real-box',
      '--role',
      'client',
      '--role',
      'compute',
      '--data-dir',
      data,
      '--update-key',
      updateKey,
    ]);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    deviceId = (JSON.parse(enrolled.stdout) as { deviceId: string }).deviceId;
    novad = spawn(BIN, ['run', '--data-dir', data], { stdio: ['ignore', 'ignore', 'pipe'] });
    await until(async () => {
      const v = await api('GET', `/api/v1/devices/${deviceId}`);
      return (v.json.modules as { name: string; state: string }[] | undefined)?.some(
        (m) => m.name === 'storage' && m.state === 'running',
      );
    });
  }, 60_000);

  afterAll(async () => {
    novad?.kill('SIGKILL');
    await area?.close();
    await app?.close();
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('registered with a document signed in Rust and runs modules as processes', async () => {
    const v = (await api('GET', `/api/v1/devices/${deviceId}`)).json;
    expect(v).toMatchObject({
      name: 'real-box',
      status: 'active',
      novadVersion: '0.7.0',
      updateRequired: false,
    });
    // The local runtime (a client's module, FR-128) and the browser module (FR-209, M7.5) run too
    // and are in the signed document the Hub validated against device-capability.json.
    expect(v.capability.modules).toEqual([
      'browser',
      'compute',
      'local-runtime',
      'management',
      'storage',
    ]);
    expect(v.capability.computePolicy).toMatchObject({ gpuSharing: 'shared' });
    const pids = (v.modules as { pid: number }[]).map((m) => m.pid);
    expect((v.modules as { name: string }[]).map((m) => m.name).sort()).toEqual([
      'browser',
      'compute',
      'local-runtime',
      'management',
      'storage',
    ]);
    expect(new Set(pids).size).toBe(5);
    expect(pids).not.toContain(novad!.pid);
  });

  it('pushes overrides that come back re-signed', async () => {
    const r = await api('PATCH', `/api/v1/devices/${deviceId}`, {
      capabilityOverrides: { scheduling: { routingWeight: 4, quietHours: ['23:00-06:00'] } },
      updateChannel: 'beta',
    });
    expect(r.status).toBe(200);
    expect(r.json.configPending).toBe(false);
    expect(r.json.capability.scheduling).toMatchObject({ routingWeight: 4 });
    expect(r.json.capability.data.updateChannel).toBe('beta');
  });

  it('stages, diffs and commits through novad; a write outside the grants asks first', async () => {
    const owner = await api('POST', `/api/v1/devices/${deviceId}/access-requests`, {
      path: proj,
      access: 'write',
    });
    expect(owner.json.status).toBe('granted');
    const file = join(proj, 'src', 'notes.md');
    const st = await api('POST', `/api/v1/devices/${deviceId}/staged`, {
      path: file,
      content: 'one\n2\n',
    });
    expect(st.status).toBe(201);
    expect(st.json).toMatchObject({ additions: 1, deletions: 1 });
    expect(st.json.diff).toContain('-two\n+2');
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    expect(
      (await api('POST', `/api/v1/devices/${deviceId}/staged/${st.json.id as string}/commit`)).json
        .status,
    ).toBe('committed');
    expect(readFileSync(file, 'utf8')).toBe('one\n2\n');
    // A changed target is a conflict.
    const st2 = await api('POST', `/api/v1/devices/${deviceId}/staged`, {
      path: file,
      content: 'mine\n',
    });
    writeFileSync(file, 'theirs\n');
    expect(
      (await api('POST', `/api/v1/devices/${deviceId}/staged/${st2.json.id as string}/commit`))
        .status,
    ).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe('theirs\n');
    // An agent outside its folders: a request with an approval card, answered on the Hub.
    const agent = { kind: 'agent', id: 'a1' };
    const out = await api('POST', `/api/v1/devices/${deviceId}/staged`, {
      path: file,
      content: 'agent\n',
      grantee: agent,
    });
    expect(out.status).toBe(403);
    expect(out.json.error.details.reason).toBe('folder_access_required');
    const approvalId = out.json.error.details.approvalId as string;
    db.raw
      .prepare(
        "UPDATE approval SET status = 'decided', decision = 'allow_once', decided_by = 'user' WHERE id = ?",
      )
      .run(approvalId);
    await events.emit({
      name: 'approval.decided',
      accountId: ACCOUNT,
      actor: 'user',
      payload: { approvalId, decision: 'allow_once', decidedBy: 'user', override: false },
    });
    const rid = out.json.error.details.requestId as string;
    await until(
      async () =>
        (await api('GET', `/api/v1/devices/${deviceId}/access-requests/${rid}`)).json.status ===
        'granted',
    );
    const ok = await api('POST', `/api/v1/devices/${deviceId}/staged`, {
      path: file,
      content: 'agent\n',
      grantee: agent,
    });
    expect(ok.status).toBe(201);
    // A device-side approval (`novad access approve`) reaches the Hub with a heartbeat.
    const req = await api('POST', `/api/v1/devices/${deviceId}/access-requests`, {
      path: join(proj, 'src'),
      access: 'read',
      grantee: { kind: 'session', id: 's1' },
    });
    expect(req.json.status).toBe('pending');
    const listed = spawnSync(BIN, ['access', 'list', '--data-dir', data], { encoding: 'utf8' });
    const pending = (
      JSON.parse(listed.stdout) as {
        requests: { id: string; status: string; grantee: { id: string } }[];
      }
    ).requests.find((r) => r.status === 'pending' && r.grantee.id === 's1')!;
    expect(spawnSync(BIN, ['access', 'approve', pending.id, '--data-dir', data]).status).toBe(0);
    await until(
      async () =>
        (await api('GET', `/api/v1/devices/${deviceId}/access-requests/${req.json.id as string}`))
          .json.status === 'granted',
    );
    const card = db.raw
      .prepare('SELECT decided_by FROM approval WHERE id = ?')
      .get(req.json.approvalId) as { decided_by: string };
    expect(card.decided_by).toBe(`device:${deviceId}`);
    // Protected paths are refused by novad even inside a grant.
    mkdirSync(join(proj, '.git'), { recursive: true });
    expect(
      (
        await api('POST', `/api/v1/devices/${deviceId}/staged`, {
          path: join(proj, '.git', 'config'),
          content: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('runs commands in the device sandbox', async () => {
    let res: Awaited<ReturnType<typeof area.service.exec>>;
    try {
      res = await area.service.exec(
        ACCOUNT,
        deviceId,
        { kind: 'user', id: ACCOUNT },
        { cmd: 'ls', args: [join(proj, 'src')], cwd: proj },
      );
    } catch (err) {
      // A host without a working sandbox refuses commands (fail closed, FR-107).
      expect((err as Error).message).toMatch(/sandbox/);
      return;
    }
    if (res.exitCode !== 0) {
      expect(res.stderr).toMatch(/bwrap|namespace|permitted/i);
      return;
    }
    expect(res.stdout).toContain('notes.md');
    // Inside the grant, below it and down to the working folder, credential locations are
    // hidden and `.git` stays read-only (FR-190, docs/12 §7.2).
    const sub = join(proj, 'keys-here');
    mkdirSync(join(sub, '.SSH'), { recursive: true });
    mkdirSync(join(sub, '.git'), { recursive: true });
    writeFileSync(join(sub, '.SSH', 'id_x'), 'SECRET-ssh');
    writeFileSync(join(sub, '.netrc'), 'SECRET-netrc');
    writeFileSync(join(sub, '.git', 'config'), '[core]\n');
    const guarded = await area.service.exec(
      ACCOUNT,
      deviceId,
      { kind: 'user', id: ACCOUNT },
      {
        cmd: '/bin/sh',
        args: ['-c', 'cat .SSH/id_x .netrc; ls -A .SSH; echo x >> .git/config || echo READ-ONLY'],
        cwd: sub,
      },
    );
    expect(guarded.stdout).not.toContain('SECRET');
    expect(guarded.stdout).not.toContain('id_x');
    expect(guarded.stdout).toContain('READ-ONLY');
    expect(readFileSync(join(sub, '.git', 'config'), 'utf8')).toBe('[core]\n');
    rmSync(sub, { recursive: true, force: true });
  });

  it('keeps Code session processes on the device and reads their output (FR-078)', async () => {
    const conn = (await area.codeEnvironments.connect(
      ACCOUNT,
      deviceId,
      new AbortController().signal,
    ))!;
    expect(await conn.hello()).toMatchObject({
      version: '0.7.0',
      platform: 'linux',
      verified: true,
    });
    let spawned: { id: string };
    try {
      spawned = await conn.spawn({ cmd: 'echo hello; ls src', cwd: proj, tag: 's:t' });
    } catch (err) {
      expect((err as Error).message).toMatch(/sandbox/);
      return;
    }
    let r = await conn.read(spawned.id, 0, 2_000);
    // Time-boxed, not count-boxed: a loaded machine can take a while to start the sandbox.
    for (const t0 = Date.now(); r.running && Date.now() - t0 < 25_000;)
      r = await conn.read(spawned.id, 0, 500);
    expect(r.running).toBe(false);
    if (r.exitCode === 0) expect(r.data).toContain('hello\nnotes.md');
    expect((await conn.processes()).map((p) => p.tag)).toContain('s:t');
    // Polling a sandboxed process can take seconds while the rest of the suite runs.
  }, 45_000);

  it('restarts a killed module and reports the crash', async () => {
    const before = (await api('GET', `/api/v1/devices/${deviceId}`)).json.modules.find(
      (m: { name: string }) => m.name === 'compute',
    );
    process.kill(before.pid as number, 'SIGKILL');
    const after = await until(async () => {
      const m = (await api('GET', `/api/v1/devices/${deviceId}`)).json.modules.find(
        (x: { name: string }) => x.name === 'compute',
      );
      return m.state === 'running' && m.pid !== before.pid ? m : null;
    });
    expect(after.restarts).toBeGreaterThanOrEqual(1);
    const names = (await events.since(null, 500, { accountId: ACCOUNT }))
      .filter((e) => e.name === 'device.module.changed')
      .map((e) => e.payload.kind);
    expect(names).toEqual(expect.arrayContaining(['crashed', 'restarted']));
    const svc = await api('POST', `/api/v1/devices/${deviceId}/services/compute/restart`);
    expect(svc.json.service.state).toBe('running');
  }, 30_000);

  it('applies a module update signed here and verified on the device', async () => {
    const script = `#!/bin/sh\nwhile IFS= read -r l; do id=$(printf '%s' "$l" | sed 's/.*"id":\\([0-9]*\\).*/\\1/'); printf '{"id":%s,"ok":true,"result":{"pong":true}}\\n' "$id"; done\n`;
    const manifest = {
      target: 'compute',
      version: '0.7.1',
      channel: 'stable' as const,
      sha256: createHash('sha256').update(script).digest('hex'),
      size: Buffer.byteLength(script),
    };
    const bundle = {
      manifest,
      signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
        'base64url',
      ),
      payload: Buffer.from(script).toString('base64'),
    };
    const r = await api('POST', `/api/v1/devices/${deviceId}/updates`, { bundles: [bundle] });
    expect(r.json.items[0]).toMatchObject({
      target: 'compute',
      status: 'applied',
      fromVersion: '0.7.0',
      toVersion: '0.7.1',
    });
    const tampered = { ...bundle, manifest: { ...manifest, version: '0.7.2' } };
    const bad = await api('POST', `/api/v1/devices/${deviceId}/updates`, { bundles: [tampered] });
    expect(bad.json.items[0]).toMatchObject({ status: 'refused' });
    expect(bad.json.items[0].detail).toMatch(/pinned key/);
  }, 30_000);

  it('stops when revoked', async () => {
    await area.service.revoke(ACCOUNT, deviceId);
    const code = await new Promise<number | null>((r) => novad!.once('exit', (c) => r(c)));
    expect(code).toBe(0);
    const state = JSON.parse(readFileSync(join(data, 'device.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({ revoked: true });
    expect(state.credential ?? null).toBeNull();
    novad = null;
    expect((await run(['run', '--data-dir', data])).status).not.toBe(0);
    // Re-adding the device enrolls a new key (the revoked one stays burned).
    const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
    const again = await run([
      'enroll',
      '--hub',
      hubUrl,
      '--token',
      t.json.token as string,
      '--listen',
      `127.0.0.1:${await freePort()}`,
      '--data-dir',
      data,
    ]);
    expect(again.status, again.stderr).toBe(0);
    expect((JSON.parse(again.stdout) as { deviceId: string }).deviceId).not.toBe(deviceId);
  }, 30_000);
});
