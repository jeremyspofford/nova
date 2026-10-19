// The firmware area (FR-146; ADR-096 D2-D4) through app.inject: a novad device enrolled with the
// devices area (FakeDevice), its management endpoint pointed at a fake novad firmware backend
// that verifies each authorization. Owner-only routes, the toggles with their confirmation through
// the settings writer, plan -> approval -> apply -> history, rollback, the watchdog, the BIOS admin
// password, unsupported hardware, and the heartbeat answer's `policy.firmwareChanges`.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import {
  FakeDevice,
  FakeFirmwareNovad,
  rawEd25519,
  type AuditRecord,
  type NotificationInput,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { EventStore } from '../src/event-store.ts';
import { setupFirmware, type FirmwareArea } from '../src/firmware.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const OWNER = '01920000-0000-7000-8000-000000000001';
const MEMBER = '01920000-0000-7000-8000-000000000002';

let db: NovaDatabase;
let app: FastifyInstance;
let devices: DevicesArea;
let area: FirmwareArea;
let events: EventStore;
let url: string;
let dir: string;
let audit: AuditRecord[];
let notes: NotificationInput[];
let diagnostics: DiagnosticsRegistry;
let settings: Partial<Record<SettingKey, unknown>>;
let writes: [string, unknown, boolean][];
let device: FakeDevice;
let fw: FakeFirmwareNovad;
let secrets: MemorySecretStore;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [OWNER, MEMBER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  db.raw
    .prepare("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?)")
    .run(OWNER, iso);
  db.raw
    .prepare("INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'member', ?)")
    .run(MEMBER, iso);
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-firmware-'));
  audit = [];
  notes = [];
  diagnostics = new DiagnosticsRegistry();
  settings = {
    'devices.minNovadVersions': {},
    'devices.wakesPerHour': 6,
    'devices.firmware.allowChanges': false,
    'devices.firmware.allowSecurityDegrading': false,
    'devices.firmware.watchdogSeconds': 300,
  };
  writes = [];
  secrets = new MemorySecretStore();
  events = new EventStore(db);
  const ctx = {
    db,
    secrets,
    events,
    dataDir: dir,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting: (key: SettingKey) => Promise.resolve(settings[key]),
    accountOf: (req: FastifyRequest) =>
      Promise.resolve((req.headers['x-account'] as string | undefined) ?? OWNER),
  } as unknown as HubContext;
  const hub = generateKeyPairSync('ed25519');
  const auditSink = { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) };
  const notifier = { notify: (n: NotificationInput) => (notes.push(n), Promise.resolve()) };
  devices = await setupDevices(ctx, {});
  area = await setupFirmware(ctx, {
    devices: devices.service,
    writeSetting: (_accountId, key, value, opts) => {
      settings[key] = value;
      writes.push([key, value, opts.confirmed]);
      return Promise.resolve();
    },
    identity: () => ({ sign: (b) => sign(null, Buffer.from(b), hub.privateKey) }),
  });
  area.useAudit(auditSink);
  area.useNotifier(notifier);
  // The one-line wiring the lead adds in app.ts (D3).
  devices.service.useFirmwarePolicy((d) => area.heartbeatPolicy(d));
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  devices.register(app);
  area.register(app);
  url = await app.listen({ port: 0, host: '127.0.0.1' });

  // Enroll a novad device, then point its management endpoint at the firmware fake.
  const t = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/novad/enroll',
    payload: { roles: ['client'] },
  });
  device = new FakeDevice({ name: 'desk' });
  await device.enroll(url, t.json<{ token: string }>().token);
  fw = new FakeFirmwareNovad({
    deviceId: device.deviceId!,
    hubPublicKey: rawEd25519(hub.publicKey).toString('base64url'),
    managementToken: device.managementToken,
  });
  db.raw
    .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
    .run(await fw.listen(), device.deviceId);
});

afterEach(async () => {
  await fw.close();
  await device.close();
  await area.close();
  await devices.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

async function api(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  as = OWNER,
) {
  const res = await app.inject({
    method,
    url: path,
    headers: { 'x-account': as },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json<Json>() : {}, headers: res.headers };
}

const base = () => `/api/v1/devices/${device.deviceId!}/firmware`;

async function allow(): Promise<void> {
  const r = await api('PUT', '/api/v1/devices/firmware/policy', {
    allowChanges: true,
    confirm: true,
  });
  expect(r.json).toEqual({ allowChanges: true, allowSecurityDegrading: false });
}

/** The owner answers the card the way POST /api/v1/approvals does. */
async function decide(approvalId: string, decision = 'allow_once'): Promise<void> {
  db.raw
    .prepare(
      `UPDATE approval SET status = 'decided', decision = ?, decided_by = 'user', decided_at = ?
       WHERE id = ?`,
    )
    .run(decision, new Date().toISOString(), approvalId);
  await events.emit({
    name: 'approval.decided',
    accountId: OWNER,
    actor: 'user',
    payload: { approvalId, decision, decidedBy: 'user' },
  });
}

async function statusOf(changeId: string): Promise<string> {
  return (await api('GET', `${base()}/changes/${changeId}`)).json.status as string;
}

async function until(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}

describe('the firmware area', () => {
  it('refuses members on every route (owner-only)', async () => {
    for (const [method, path, body] of [
      ['GET', base()],
      ['POST', `${base()}/plan`, { changes: [{ key: 'wol', value: 'LanOnly' }] }],
      ['GET', `${base()}/history`],
      ['GET', '/api/v1/devices/firmware/policy'],
      ['PUT', '/api/v1/devices/firmware/policy', { allowChanges: true, confirm: true }],
      ['PUT', `${base()}/admin-password`, { password: 'x' }],
    ] as const) {
      const r = await api(method, path, body, MEMBER);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.error.details).toEqual({ reason: 'owner_only' });
    }
    expect(settings['devices.firmware.allowChanges']).toBe(false);
    expect(fw.calls).toEqual([]);
  });

  it('keeps the toggles off by default; turning one on needs a confirmation and is audited', async () => {
    expect((await api('GET', '/api/v1/devices/firmware/policy')).json).toEqual({
      allowChanges: false,
      allowSecurityDegrading: false,
    });
    // Off: planning is refused, reading is not.
    const off = await api('POST', `${base()}/plan`, {
      changes: [{ key: 'wol', value: 'LanOnly' }],
    });
    expect(off.status).toBe(403);
    expect(off.json.error.code).toBe('firmware_disabled');
    expect((await api('GET', base())).json).toMatchObject({
      supported: true,
      policy: { allowChanges: false },
    });

    const unconfirmed = await api('PUT', '/api/v1/devices/firmware/policy', { allowChanges: true });
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.json.error.details).toEqual({ reason: 'consent_required' });
    expect((await api('PUT', '/api/v1/devices/firmware/policy', {})).status).toBe(400);
    await allow();
    const sec = await api('PUT', '/api/v1/devices/firmware/policy', {
      allowSecurityDegrading: true,
      confirm: true,
    });
    expect(sec.json).toEqual({ allowChanges: true, allowSecurityDegrading: true });
    // Turning off needs no confirmation.
    await api('PUT', '/api/v1/devices/firmware/policy', { allowSecurityDegrading: false });
    // Each change goes through the settings writer with its confirmation; the writer's event is
    // the one audit entry (the ops subscriber's), so the area appends none (ADR-096 D3).
    expect(writes).toEqual([
      ['devices.firmware.allowChanges', true, true],
      ['devices.firmware.allowSecurityDegrading', true, true],
      ['devices.firmware.allowSecurityDegrading', false, false],
    ]);
    expect(audit.filter((a) => a.kind === 'settings')).toEqual([]);
    const matrix = await api('GET', '/api/v1/devices/firmware/support');
    expect((matrix.json.items as { vendor: string }[]).map((m) => m.vendor)).toContain(
      'generic-uefi',
    );
  });

  it('plans, asks, applies after the owner decides, and lists the history', async () => {
    await allow();
    const bad = await api('POST', `${base()}/plan`, {
      changes: [{ key: 'biosPassword', value: 'x' }],
    });
    expect(bad.status).toBe(400);
    const dup = await api('POST', `${base()}/plan`, {
      changes: [
        { key: 'wol', value: 'LanOnly' },
        { key: 'wol', value: 'LanWlan' },
      ],
    });
    expect(dup.status).toBe(400);

    const plan = await api('POST', `${base()}/plan`, {
      changes: [{ key: 'wol', value: 'LanOnly' }],
    });
    expect(plan.status).toBe(201);
    expect(plan.json).toMatchObject({
      status: 'planned',
      diff: [{ key: 'wol', from: 'Disabled', to: 'LanOnly' }],
    });
    const id = plan.json.id as string;
    const asked = await api('POST', `${base()}/changes/${id}/request-approval`, {
      note: 'for WoL',
    });
    expect(asked.json.status).toBe('awaiting_approval');
    const approvalId = asked.json.approval.id as string;
    expect(notes.at(-1)).toMatchObject({ kind: 'approval', href: `/approvals/${approvalId}` });
    const early = await api('POST', `${base()}/changes/${id}/apply`, {});
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('approval_required');

    await decide(approvalId);
    await until(async () => (await statusOf(id)) === 'approved');
    const applied = await api('POST', `${base()}/changes/${id}/apply`, { reboot: false });
    expect(applied.json).toMatchObject({ status: 'applied', reboot: false });
    expect(fw.value('wol')).toBe('LanOnly');
    const history = await api('GET', `${base()}/history?limit=10`);
    expect(history.json.changes[0]).toMatchObject({ id, status: 'applied' });
    expect(history.json.snapshots).toHaveLength(1);
    expect(audit.find((a) => a.action === 'device.firmware.apply')?.detail).toMatchObject({
      before: { wol: 'Disabled' },
      after: { wol: 'LanOnly' },
    });
    expect(await diagnostics.collect()).toMatchObject({
      firmware: { allowChanges: true, changes: { applied: 1 } },
    });

    // Roll back to the snapshot: an approval again, then apply.
    const rb = await api(
      'POST',
      `${base()}/snapshots/${history.json.snapshots[0].id as string}/rollback`,
      {},
    );
    expect(rb.status).toBe(202);
    expect(rb.json).toMatchObject({ kind: 'rollback', status: 'awaiting_approval' });
    await decide(rb.json.approval.id as string);
    await until(async () => (await statusOf(rb.json.id as string)) === 'approved');
    expect(
      (await api('POST', `${base()}/changes/${rb.json.id as string}/apply`, {})).json.status,
    ).toBe('applied');
    expect(fw.value('wol')).toBe('Disabled');
    expect(await statusOf(id)).toBe('rolled_back');
  });

  it('refuses a security-degrading change without the override', async () => {
    await allow();
    const plan = await api('POST', `${base()}/plan`, {
      changes: [{ key: 'secureBoot', value: 'Disabled' }],
    });
    const r = await api('POST', `${base()}/changes/${plan.json.id as string}/request-approval`, {});
    expect(r.status).toBe(403);
    expect(r.json.error.details).toMatchObject({
      reason: 'security_degrading',
      keys: ['secureBoot'],
    });
    await api('PUT', '/api/v1/devices/firmware/policy', {
      allowSecurityDegrading: true,
      confirm: true,
    });
    const ok = await api(
      'POST',
      `${base()}/changes/${plan.json.id as string}/request-approval`,
      {},
    );
    expect(ok.json.status).toBe('awaiting_approval');
  });

  it('closes a change from the watchdog events and tells the owner', async () => {
    await allow();
    const plan = await api('POST', `${base()}/plan`, {
      changes: [{ key: 'powerOnAfterPowerLoss', value: 'On' }],
    });
    const id = plan.json.id as string;
    const asked = await api('POST', `${base()}/changes/${id}/request-approval`, {});
    await decide(asked.json.approval.id as string);
    await until(async () => (await statusOf(id)) === 'approved');
    const applied = await api('POST', `${base()}/changes/${id}/apply`, { reboot: true });
    expect(applied.json.watchdog).toMatchObject({ state: 'pending' });
    // The owner's watchdog length (`devices.firmware.watchdogSeconds`) reached the device.
    expect(fw.lastWatchdogSeconds).toBe(300);
    fw.bootFailed();
    // What the devices area hands over from the next heartbeat (wiring in app.ts).
    await area.heartbeatEvents(OWNER, device.deviceId!, fw.events.splice(0));
    const view = (await api('GET', `${base()}/changes/${id}`)).json;
    expect(view).toMatchObject({ status: 'reverted', watchdog: { state: 'reverted' } });
    expect(notes.at(-1)).toMatchObject({ kind: 'attention', title: 'Firmware change reverted' });
  });

  it('answers the toggle in the heartbeat policy', async () => {
    const before = await device.heartbeat();
    expect(before.status).toBe(200);
    expect((before.json.policy as { firmwareChanges: boolean }).firmwareChanges).toBe(false);
    await allow();
    const after = await device.heartbeat();
    expect((after.json.policy as { firmwareChanges: boolean }).firmwareChanges).toBe(true);
  });

  it('stores the BIOS admin password write-only', async () => {
    const put = await api('PUT', `${base()}/admin-password`, { password: 'correct horse' });
    expect(put.json).toEqual({ stored: true });
    expect(put.headers['cache-control']).toBe('no-store');
    const read = await api('GET', base());
    expect(read.json.adminPasswordStored).toBe(true);
    expect(JSON.stringify(read.json)).not.toContain('correct horse');
    expect(JSON.stringify(audit)).not.toContain('correct horse');
    expect((await api('DELETE', `${base()}/admin-password`)).json).toEqual({ stored: false });
    expect((await api('PUT', `${base()}/admin-password`, { password: '' })).status).toBe(400);
  });

  it('drops the BIOS admin password when the device is revoked', async () => {
    await api('PUT', `${base()}/admin-password`, { password: 'correct horse' });
    const ref = `secret://devices/${device.deviceId!}/bios-admin`;
    expect(await secrets.has(ref)).toBe(true);
    await devices.service.revoke(OWNER, device.deviceId!);
    expect(await secrets.has(ref)).toBe(false);
    expect(audit.find((a) => a.action === 'device.firmware.password.clear')).toMatchObject({
      kind: 'secret',
      detail: { reason: 'device_revoked' },
    });
  });

  it('refuses unsupported hardware with the reason', async () => {
    await allow();
    fw.supported = false;
    fw.reason = 'no firmware-attributes driver';
    const r = await api('POST', `${base()}/plan`, { changes: [{ key: 'wol', value: 'LanOnly' }] });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({
      reason: 'unsupported_hardware',
      detail: 'no firmware-attributes driver',
    });
    const read = await api('GET', `${base()}?fresh=1`);
    expect(read.json).toMatchObject({ supported: false, cached: false });
    expect(
      (await api('GET', '/api/v1/devices/01920000-0000-7000-8000-00000000ffff/firmware')).status,
    ).toBe(404);
  });
});
