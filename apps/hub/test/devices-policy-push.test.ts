// The device-side toggles reach a device at once (ADR-096 D3; J9.5 bug 2): turning a switch on or
// off pushes `policy: {firmwareChanges, lowLevelBoot}` to every reachable device with
// `POST /agent/v1/config`, and a firmware apply or a boot trial first makes sure the device has
// the current toggle. A device that still refuses for that reason gets the policy again and one
// retry; if it still refuses, the request fails clearly and its approval is not spent. The fake
// novads (firmware and boot) take the toggles from `/agent/v1/config` like novad does.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import {
  BOOT_SET_PATH,
  FakeBootDevice,
  FakeDevice,
  FakeFirmwareNovad,
  rawEd25519,
  type AuditRecord,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupBoot, type BootArea } from '../src/boot.ts';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { setupFirmware, type FirmwareArea } from '../src/firmware.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

interface Base {
  dir: string;
  db: NovaDatabase;
  events: EventStore;
  settings: Partial<Record<SettingKey, unknown>>;
  audit: AuditRecord[];
  ctx: HubContext;
  hubKey: ReturnType<typeof generateKeyPairSync>;
}

async function base(settings: Partial<Record<SettingKey, unknown>>): Promise<Base> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-policy-push-'));
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  db.raw
    .prepare("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?)")
    .run(ACCOUNT, iso);
  const events = new EventStore(db);
  const ctx = {
    config: {},
    db,
    secrets: new MemorySecretStore(),
    events,
    dataDir: join(dir, 'data'),
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics: new DiagnosticsRegistry(),
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (_req: FastifyRequest) => Promise.resolve(ACCOUNT),
  } as unknown as HubContext;
  return {
    dir,
    db,
    events,
    settings,
    audit: [],
    ctx,
    hubKey: generateKeyPairSync('ed25519'),
  };
}

/** What the Hub's settings writer does: store the value and announce it. */
async function writeToggle(b: Base, key: SettingKey, value: boolean): Promise<void> {
  b.settings[key] = value;
  await b.events.emit({
    name: 'settings.changed',
    accountId: ACCOUNT,
    actor: 'user',
    payload: { key, scope: 'global' },
  });
}

async function until(fn: () => Promise<boolean> | boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function inject(app: FastifyInstance) {
  return async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, json: res.body ? res.json<Json>() : {} };
  };
}

function errorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
}

// ---- firmware ---------------------------------------------------------------------------------

describe('firmware: the toggle reaches the device before an apply', () => {
  let b: Base;
  let app: FastifyInstance;
  let devices: DevicesArea;
  let area: FirmwareArea;
  let device: FakeDevice;
  let fw: FakeFirmwareNovad;
  let api: ReturnType<typeof inject>;

  beforeEach(async () => {
    b = await base({ 'devices.firmware.allowChanges': false });
    devices = await setupDevices(b.ctx, {});
    area = await setupFirmware(b.ctx, {
      devices: devices.service,
      writeSetting: (_a, key, value) => writeToggle(b, key, value),
      identity: () => ({ sign: (x) => sign(null, Buffer.from(x), b.hubKey.privateKey) }),
    });
    area.useAudit({ append: (r) => (b.audit.push(r), Promise.resolve()) });
    devices.service.useFirmwarePolicy((d) => area.heartbeatPolicy(d));
    app = Fastify();
    errorHandler(app);
    devices.register(app);
    area.register(app);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    api = inject(app);
    const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
    device = new FakeDevice({ name: 'desk' });
    await device.enroll(url, t.json.token as string);
    // The device's copy of the toggle is off, as it was when it last heard from the Hub.
    fw = new FakeFirmwareNovad({
      deviceId: device.deviceId!,
      hubPublicKey: rawEd25519(b.hubKey.publicKey).toString('base64url'),
      managementToken: device.managementToken,
      firmwareChanges: false,
    });
    b.db.raw
      .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
      .run(await fw.listen(), device.deviceId);
  });

  afterEach(async () => {
    await fw.close();
    await device.close();
    await area.close();
    await devices.close();
    await app.close();
    b.db.close();
    rmSync(b.dir, { recursive: true, force: true });
  });

  const fwBase = () => `/api/v1/devices/${device.deviceId!}/firmware`;

  /** Plan wol -> LanOnly, ask, and answer the card as the owner. */
  async function approvedChange(): Promise<string> {
    const plan = await api('POST', `${fwBase()}/plan`, {
      changes: [{ key: 'wol', value: 'LanOnly' }],
    });
    expect(plan.status, JSON.stringify(plan.json)).toBe(201);
    const id = plan.json.id as string;
    const asked = await api('POST', `${fwBase()}/changes/${id}/request-approval`, {});
    const approvalId = asked.json.approval.id as string;
    b.db.raw
      .prepare(
        `UPDATE approval SET status = 'decided', decision = 'allow_once', decided_by = 'user',
           decided_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), approvalId);
    await b.events.emit({
      name: 'approval.decided',
      accountId: ACCOUNT,
      actor: 'user',
      payload: { approvalId, decision: 'allow_once', decidedBy: 'user' },
    });
    await until(
      async () => (await api('GET', `${fwBase()}/changes/${id}`)).json.status === 'approved',
    );
    return id;
  }

  const paths = () => fw.calls.map((c) => c.path);

  it('applies right after the switch is turned on', async () => {
    // On, with no time for the heartbeat (the settings event's push may still be on its way).
    b.settings['devices.firmware.allowChanges'] = true;
    const id = await approvedChange();
    const applied = await api('POST', `${fwBase()}/changes/${id}/apply`, {});
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json.status).toBe('applied');
    expect(fw.policy.firmwareChanges).toBe(true);
    expect(fw.value('wol')).toBe('LanOnly');
    // The policy went first.
    expect(paths().indexOf('/agent/v1/config')).toBeLessThan(
      paths().indexOf('/agent/v1/firmware/apply'),
    );
    expect(paths().filter((p) => p === '/agent/v1/firmware/apply')).toHaveLength(1);
  });

  it('pushes again and retries once when the device still refuses', async () => {
    b.settings['devices.firmware.allowChanges'] = true;
    // The Hub believes the device has it (a heartbeat answer it may have lost).
    expect((await device.heartbeat()).json.policy).toMatchObject({ firmwareChanges: true });
    const id = await approvedChange();
    const applied = await api('POST', `${fwBase()}/changes/${id}/apply`, {});
    expect(applied.json.status, JSON.stringify(applied.json)).toBe('applied');
    const applies = fw.calls.filter((c) => c.path === '/agent/v1/firmware/apply');
    expect(applies).toHaveLength(2);
    const ids = applies.map(
      (c) => (c.body.authorization as { payload: { changeId: string } }).payload.changeId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(paths().filter((p) => p === '/agent/v1/config')).toHaveLength(1);
  });

  it('fails clearly and keeps the change approved when the device never takes it', async () => {
    b.settings['devices.firmware.allowChanges'] = true;
    // A device that ignores the pushed toggle (an older novad).
    Object.defineProperty(fw.policy, 'firmwareChanges', {
      get: () => false,
      set: () => undefined,
      configurable: true,
    });
    const id = await approvedChange();
    const r = await api('POST', `${fwBase()}/changes/${id}/apply`, {});
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'device_policy_stale' },
      retryable: true,
    });
    expect((await api('GET', `${fwBase()}/changes/${id}`)).json.status).toBe('approved');
    // Once the device has it, the same approval applies.
    Object.defineProperty(fw.policy, 'firmwareChanges', {
      value: true,
      writable: true,
      configurable: true,
    });
    expect((await api('POST', `${fwBase()}/changes/${id}/apply`, {})).json.status).toBe('applied');
  });

  it('reaches the device at once when the switch is turned off (and on)', async () => {
    await api('PUT', '/api/v1/devices/firmware/policy', { allowChanges: true, confirm: true });
    await until(() => fw.policy.firmwareChanges);
    await api('PUT', '/api/v1/devices/firmware/policy', { allowChanges: false });
    await until(() => !fw.policy.firmwareChanges);
    const pushes = fw.calls.filter((c) => c.path === '/agent/v1/config');
    expect(pushes.map((c) => c.body)).toEqual([
      { policy: { firmwareChanges: true, lowLevelBoot: false } },
      { policy: { firmwareChanges: false, lowLevelBoot: false } },
    ]);
  });
});

// ---- boot -------------------------------------------------------------------------------------

describe('boot: the toggle reaches the device before a trial', () => {
  let b: Base;
  let app: FastifyInstance;
  let policy: PolicyAreaFull;
  let devices: DevicesArea;
  let boot: BootArea;
  let device: FakeDevice;
  let fake: FakeBootDevice;
  let api: ReturnType<typeof inject>;

  beforeEach(async () => {
    b = await base({ 'devices.boot.allowLowLevel': true });
    const sinks = {
      audit: { append: (r: AuditRecord) => (b.audit.push(r), Promise.resolve()) },
      notifier: { notify: () => Promise.resolve() },
    };
    policy = await setupPolicy({ ...b.ctx, ...sinks }, { home: join(b.dir, 'home') });
    let fakeRef: FakeBootDevice | null = null;
    // Every management call reaches the D5 fake (its boot routes and `/agent/v1/config`).
    const transport = {
      post: (url: string, token: string, body: unknown, ms: number) =>
        fakeRef!.transport().post(url, token, body, ms),
    };
    devices = await setupDevices(b.ctx, { ...sinks, transport });
    boot = await setupBoot(b.ctx, {
      devices: devices.service,
      ...sinks,
      hubIdentity: () => ({ sign: (x) => sign(null, Buffer.from(x), b.hubKey.privateKey) }),
      transport,
      sweepIntervalMs: 3_600_000,
    });
    devices.service.useBootPolicy(() => boot.lowLevelBoot());
    app = Fastify();
    errorHandler(app);
    policy.register(app);
    devices.register(app);
    boot.register(app);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    api = inject(app);
    const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
    device = new FakeDevice({ name: 'lab-box' });
    await device.enroll(url, t.json.token as string);
    // The device's copy of the toggle is still off.
    fake = new FakeBootDevice({
      hubPublicKey: rawEd25519(b.hubKey.publicKey).toString('base64url'),
      deviceId: device.deviceId!,
      managementToken: device.managementToken,
      lowLevelBoot: false,
    });
    fakeRef = fake;
  });

  afterEach(async () => {
    await device.close();
    await boot.close();
    await devices.close();
    await policy.close();
    await app.close();
    b.db.close();
    rmSync(b.dir, { recursive: true, force: true });
  });

  const bootBase = () => `/api/v1/devices/${device.deviceId!}/boot`;

  /** Create a profile, ask to try it and approve the card through the policy area. */
  async function approvedTry(): Promise<Json> {
    const p = await api('POST', `${bootBase()}/profiles`, {
      name: 'next kernel',
      entryId: 'linux-next.conf',
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const r = await api('POST', `${bootBase()}/profiles/${p.json.id as string}/try`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    const d = await api('POST', '/api/v1/approvals', {
      approvalId: r.json.approvalId,
      decision: 'allow_once',
    });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    return r.json;
  }

  const request = async (id: string) => (await api('GET', `${bootBase()}/requests/${id}`)).json;
  const sets = () => fake.calls.filter((c) => c.path === BOOT_SET_PATH);

  it('sends an approved trial right after the switch is on', async () => {
    const r = await approvedTry();
    await until(async () => (await request(r.id as string)).status === 'sent');
    expect(fake.lowLevelBoot).toBe(true);
    expect(fake.oneShot).toBe('linux-next.conf');
    const paths = fake.calls.map((c) => c.path);
    expect(paths.indexOf('/agent/v1/config')).toBeLessThan(paths.indexOf(BOOT_SET_PATH));
  });

  it('pushes again and retries once with a new change id when the device still refuses', async () => {
    // The Hub believes the device has it (a heartbeat answer it may have lost).
    expect((await device.heartbeat()).json.policy).toMatchObject({ lowLevelBoot: true });
    const r = await approvedTry();
    await until(async () => (await request(r.id as string)).status === 'sent');
    expect(sets()).toHaveLength(2);
    const ids = sets().map(
      (c) => (c.body.authorization as { payload: { changeId: string } }).payload.changeId,
    );
    expect(new Set(ids).size).toBe(2);
    expect((await request(r.id as string)).changeId).toBe(ids[1]);
  });

  it('keeps the approval when the device never takes it, and sends once it does', async () => {
    // A device that ignores the pushed toggle (an older novad).
    Object.defineProperty(fake, 'lowLevelBoot', {
      get: () => false,
      set: () => undefined,
      configurable: true,
    });
    const r = await approvedTry();
    await until(async () => (await request(r.id as string)).error !== null);
    const held = await request(r.id as string);
    expect(held).toMatchObject({
      status: 'awaiting_approval',
      decidedAt: null,
      error: { code: 'conflict', reason: 'device_policy_stale' },
    });
    expect(fake.oneShot).toBeNull();
    expect((await api('GET', `/api/v1/approvals/${r.approvalId as string}`)).json.decision).toBe(
      'allow_once',
    );
    // The device takes it later: the sweep sends the held request with the same approval.
    Object.defineProperty(fake, 'lowLevelBoot', {
      value: true,
      writable: true,
      configurable: true,
    });
    await boot.service.sweep();
    expect(await request(r.id as string)).toMatchObject({ status: 'sent', error: null });
    expect(fake.oneShot).toBe('linux-next.conf');
  });

  it('reaches the device at once when the switch is turned off', async () => {
    fake.lowLevelBoot = true;
    await writeToggle(b, 'devices.boot.allowLowLevel', false);
    await until(() => !fake.lowLevelBoot);
    expect(fake.calls.find((c) => c.path === '/agent/v1/config')?.body).toEqual({
      policy: { firmwareChanges: false, lowLevelBoot: false },
    });
    // Other settings push nothing.
    const before = fake.calls.length;
    await b.events.emit({
      name: 'settings.changed',
      accountId: ACCOUNT,
      actor: 'user',
      payload: { key: 'devices.wakesPerHour', scope: 'global' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls.length).toBe(before);
  });
});
