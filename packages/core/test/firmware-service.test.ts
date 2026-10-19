// The Hub's firmware service (FR-146; ADR-096 D2-D4) against a fake novad on 127.0.0.1 that
// verifies every authorization with authz.ts: the toggle off refuses, plan -> approval -> apply
// with before/after in the audit, a base mismatch, the security-degrading override, rollback from
// the Hub's copy when the device lost its snapshot, the watchdog events and sweep, unsupported
// hardware, a replayed authorization, the BIOS admin password, and the channel choice for https.
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, SETTINGS, type FirmwareChangeView } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  FakeFirmwareNovad,
  FirmwareService,
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  authorizeDeviceBody,
  biosPasswordRef,
  deviceAuthzBodySha256,
  httpDeviceTransport,
  managementTokenRef,
  rawEd25519,
  watchdogNotice,
  type AuditRecord,
  type DeviceTransport,
  type FirmwareDeviceRef,
  type FirmwareServiceOptions,
  type NotificationInput,
} from '../src/index.ts';
import { useBlobKey } from '../src/attachments.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
const DEVICE = '01920000-0000-7000-8000-00000000d001';
const TOKEN = 'nvdm_firmware_test_token_0123456789';

interface Env {
  db: NovaDatabase;
  dir: string;
  secrets: MemorySecretStore;
  events: MemoryEventSink;
  audit: AuditRecord[];
  notes: NotificationInput[];
  fake: FakeFirmwareNovad;
  svc: FirmwareService;
  flags: { allowChanges: boolean; allowSecurityDegrading: boolean; watchdogSeconds?: number };
  device: FirmwareDeviceRef;
  clock: { now: number };
  hubKey: string;
  /** The devices area revokes (or decommissions) the device. */
  revoke(): Promise<void>;
  /** Signs as the Hub identity. */
  signer: { sign(b: Uint8Array | string): Buffer };
  close(): Promise<void>;
}

async function env(
  opts: {
    fake?: Partial<ConstructorParameters<typeof FakeFirmwareNovad>[0]>;
    svc?: Partial<FirmwareServiceOptions>;
    os?: string | null;
  } = {},
): Promise<Env> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  const devKey = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
  db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key, roles,
         status, created_at, updated_at) VALUES (?, ?, 'desk', 'client', 'linux', ?, ?, '["client"]',
         'active', ?, ?)`,
    )
    .run(DEVICE, ACCOUNT, `fp-${DEVICE}`, devKey, iso, iso);
  const dir = mkdtempSync(join(tmpdir(), 'nova-firmware-'));
  const secrets = new MemorySecretStore();
  await secrets.put(managementTokenRef(DEVICE), TOKEN);
  const hub = generateKeyPairSync('ed25519');
  const hubKey = rawEd25519(hub.publicKey).toString('base64url');
  const clock = { now: Date.parse('2026-10-19T12:00:00.000Z') };
  const fake = new FakeFirmwareNovad({
    deviceId: DEVICE,
    hubPublicKey: hubKey,
    managementToken: TOKEN,
    now: () => new Date(clock.now),
    ...opts.fake,
  });
  const endpoint = await fake.listen();
  const device: FirmwareDeviceRef = {
    row: {
      id: DEVICE,
      accountId: ACCOUNT,
      name: 'desk',
      status: 'active',
      platform: opts.os === undefined ? 'linux' : opts.os,
      publicKey: devKey,
    },
    endpoint,
  };
  const signer = { sign: (b: Uint8Array | string) => sign(null, Buffer.from(b), hub.privateKey) };
  const flags = {
    allowChanges: true,
    allowSecurityDegrading: false,
    watchdogSeconds: 600 as number | undefined,
  };
  const revokeHooks = new Set<(accountId: string, deviceId: string) => void | Promise<void>>();
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const notes: NotificationInput[] = [];
  const svc = new FirmwareService({
    db,
    secrets,
    events,
    dataDir: dir,
    devices: {
      onRevoked: (hook) => {
        revokeHooks.add(hook);
        return () => revokeHooks.delete(hook);
      },
      device: (accountId, deviceId) => {
        if (accountId !== ACCOUNT || deviceId !== DEVICE)
          return Promise.reject(new NovaError('not_found', 'device not found'));
        return Promise.resolve(device);
      },
    },
    settings: {
      allowChanges: () => Promise.resolve(flags.allowChanges),
      allowSecurityDegrading: () => Promise.resolve(flags.allowSecurityDegrading),
      watchdogSeconds: () => Promise.resolve(flags.watchdogSeconds ?? NaN),
    },
    identity: () => signer,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    now: () => new Date(clock.now),
    ...opts.svc,
  });
  return {
    db,
    dir,
    secrets,
    events,
    audit,
    notes,
    fake,
    svc,
    flags,
    device,
    clock,
    hubKey,
    signer,
    revoke: async () => {
      for (const hook of revokeHooks) await hook(ACCOUNT, DEVICE);
    },
    close: async () => {
      await fake.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let e: Env;
afterEach(async () => {
  useBlobKey(e.dir, null);
  await e.close();
});

async function code(p: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return { code: err.code, details: err.details ?? null };
    throw err;
  }
  throw new Error('expected a refusal');
}

/** The owner answers the card, as POST /api/v1/approvals does (decided_by `user`). */
async function decide(view: FirmwareChangeView, decision = 'allow_once', by = 'user') {
  const id = view.approval!.id;
  e.db.raw
    .prepare(
      `UPDATE approval SET status = 'decided', decision = ?, decided_by = ?, decided_at = ?
       WHERE id = ?`,
    )
    .run(decision, by, new Date(e.clock.now).toISOString(), id);
  await e.svc.onApprovalDecided(ACCOUNT, id, decision);
}

async function planned(changes: { key: string; value: string }[]) {
  return e.svc.plan(ACCOUNT, DEVICE, changes as never);
}

async function approved(changes: { key: string; value: string }[]) {
  const plan = await planned(changes);
  const asked = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id);
  await decide(asked);
  return asked;
}

describe('reading and the toggle', () => {
  beforeEach(async () => {
    e = await env();
  });

  it('reads through the device, caches it for 60 s and keeps only allowlisted keys', async () => {
    const r = await e.svc.read(ACCOUNT, DEVICE);
    expect(r).toMatchObject({ supported: true, cached: false, method: 'fake' });
    expect(r.support?.vendor).toBe('dell');
    expect(r.settings.map((s) => s.key)).toContain('secureBoot');
    expect((await e.svc.read(ACCOUNT, DEVICE)).cached).toBe(true);
    e.clock.now += 61_000;
    expect((await e.svc.read(ACCOUNT, DEVICE)).cached).toBe(false);
    expect((await e.svc.read(ACCOUNT, DEVICE, { fresh: true })).cached).toBe(false);
    expect(e.fake.calls.filter((c) => c.path.endsWith('/read'))).toHaveLength(3);
    expect(e.svc.facts(DEVICE)).toMatchObject({ supported: true, vendor: 'Dell Inc.' });
    expect(e.audit.filter((a) => a.action === 'device.firmware.read')).toHaveLength(3);
    // Another account's device does not exist for this one.
    expect((await code(e.svc.read(OTHER, DEVICE))).code).toBe('not_found');
  });

  it('refuses plan, approval and apply while the toggle is off, and reads anyway', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    e.flags.allowChanges = false;
    expect(await e.svc.firmwareChangesAllowed()).toBe(false);
    expect((await e.svc.read(ACCOUNT, DEVICE)).policy.allowChanges).toBe(false);
    expect((await code(planned([{ key: 'wol', value: 'LanOnly' }]))).code).toBe(
      'firmware_disabled',
    );
    expect((await code(e.svc.requestApproval(ACCOUNT, DEVICE, plan.id))).code).toBe(
      'firmware_disabled',
    );
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).code).toBe('firmware_disabled');
    expect(e.fake.value('wol')).toBe('Disabled');
    expect(e.fake.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
  });

  it('a device whose own toggle is still off refuses a valid authorization', async () => {
    e.fake.policy.firmwareChanges = false;
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).code).toBe('firmware_disabled');
    // Nothing final happened: once the device learns the toggle, the same approval works.
    e.fake.policy.firmwareChanges = true;
    expect((await e.svc.apply(ACCOUNT, DEVICE, plan.id)).status).toBe('applied');
  });
});

describe('plan, approval and apply', () => {
  beforeEach(async () => {
    e = await env();
  });

  it('plans, asks, applies and records before/after, with a sealed snapshot copy', async () => {
    useBlobKey(e.dir, Buffer.alloc(32, 9));
    const plan = await planned([
      { key: 'wol', value: 'LanOnly' },
      { key: 'powerOnAfterPowerLoss', value: 'On' },
      { key: 'fanProfile', value: 'Quiet' },
    ]);
    expect(plan).toMatchObject({ status: 'planned', kind: 'apply', securityDegrading: false });
    expect(plan.diff.map((d) => [d.key, d.from, d.to])).toEqual([
      ['wol', 'Disabled', 'LanOnly'],
      ['powerOnAfterPowerLoss', 'Off', 'On'],
    ]);
    expect(plan.refused).toEqual([{ key: 'fanProfile', reason: 'read_only' }]);
    // Planning changes nothing on the device.
    expect(e.fake.value('wol')).toBe('Disabled');
    // The Hub copy is sealed on disk; the row holds keys and hash only.
    const snap = e.db.raw.prepare('SELECT * FROM firmware_snapshot').get() as Record<
      string,
      string
    >;
    expect(snap.keys_json).toContain('secureBoot');
    expect(JSON.stringify(snap)).not.toContain('Disabled');
    const sealed = readFileSync(join(e.dir, snap.blob_path!));
    expect(sealed.toString('utf8')).not.toContain('Disabled');
    expect(e.svc.snapshotCopyExists(snap.id!)).toBe(true);

    const asked = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id, 'Wake it at night');
    expect(asked.status).toBe('awaiting_approval');
    const card = e.db.raw
      .prepare('SELECT * FROM approval WHERE id = ?')
      .get(asked.approval!.id) as Record<string, unknown>;
    expect(card).toMatchObject({
      risk: 'high',
      tier: 'confirm_at_action',
      tool_name: 'device.firmware.apply',
      status: 'pending',
      scope: `device:${DEVICE}`,
    });
    expect(String(card.requested_action)).toContain('wol Disabled -> LanOnly');
    expect(JSON.parse(String(card.args_preview)).diff).toHaveLength(2);
    expect(e.notes.at(-1)).toMatchObject({
      kind: 'approval',
      href: `/approvals/${asked.approval!.id}`,
    });
    // Asking again while the card is open returns the same card.
    expect((await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id)).approval!.id).toBe(
      asked.approval!.id,
    );
    // Not before the owner decides.
    const early = await code(e.svc.apply(ACCOUNT, DEVICE, plan.id));
    expect(early).toEqual({
      code: 'approval_required',
      details: { reason: 'approval_required', approvalId: asked.approval!.id },
    });

    await decide(asked);
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('approved');
    const done = await e.svc.apply(ACCOUNT, DEVICE, plan.id);
    expect(done).toMatchObject({ status: 'applied', reboot: false, watchdog: null });
    expect(e.fake.value('wol')).toBe('LanOnly');
    expect(e.fake.value('powerOnAfterPowerLoss')).toBe('On');
    // The device got a verified firmware.apply authorization for this approval.
    const call = e.fake.calls.find((c) => c.path.endsWith('/apply'))!;
    const auth = call.body.authorization as { payload: Record<string, unknown> };
    expect(auth.payload).toMatchObject({
      kind: 'firmware.apply',
      deviceId: DEVICE,
      approvalId: asked.approval!.id,
    });
    expect(call.body).not.toHaveProperty('allowSecurityDegrading');
    const applied = e.audit.find((a) => a.action === 'device.firmware.apply')!;
    expect(applied.result).toBe('ok');
    expect(applied.detail).toMatchObject({
      before: { wol: 'Disabled', powerOnAfterPowerLoss: 'Off' },
      after: { wol: 'LanOnly', powerOnAfterPowerLoss: 'On' },
    });
    expect(e.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['device.firmware.plan', 'device.firmware.approval']),
    );
    // Once only.
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'already_applied',
    });
    expect((await code(e.svc.requestApproval(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'already_applied',
    });
    const history = await e.svc.history(ACCOUNT, DEVICE);
    expect(history.changes[0]).toMatchObject({ id: plan.id, status: 'applied' });
    expect(history.snapshots).toHaveLength(1);
    expect(
      e.events.events
        .filter((x) => x.name === 'device.firmware.changed')
        .map((x) => x.payload.status),
    ).toEqual(['planned', 'awaiting_approval', 'approved', 'applied']);
  });

  it('refuses a denied card, a hook answer, an expired card and an edited change', async () => {
    const plan = await planned([{ key: 'wol', value: 'LanOnly' }]);
    const asked = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id);
    await decide(asked, 'deny_continue');
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('planned');
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'approval_denied',
    });
    // A new card after a denial.
    const again = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id);
    expect(again.approval!.id).not.toBe(asked.approval!.id);
    await decide(again, 'allow_once', 'hook:abc');
    // Not the signed-in user's answer: the change stays planned.
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('planned');
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'approval_denied',
    });
    // A hook's answer never stands: asking again opens a card the owner must answer.
    const third = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id);
    expect(third).toMatchObject({ status: 'awaiting_approval' });
    expect(third.approval!.id).not.toBe(again.approval!.id);

    const p2 = await planned([{ key: 'virtualization', value: 'Disabled' }]);
    const a2 = await e.svc.requestApproval(ACCOUNT, DEVICE, p2.id);
    await decide(a2);
    e.db.raw.prepare('UPDATE firmware_change SET diff_json = ? WHERE id = ?').run(
      JSON.stringify([
        {
          key: 'virtualization',
          vendorKey: 'V',
          from: 'Enabled',
          to: 'Enabled',
          securityDegrading: false,
        },
      ]),
      p2.id,
    );
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, p2.id))).details).toMatchObject({
      reason: 'approval_mismatch',
    });

    const p3 = await planned([{ key: 'virtualization', value: 'Disabled' }]);
    const a3 = await e.svc.requestApproval(ACCOUNT, DEVICE, p3.id);
    await decide(a3);
    e.clock.now += 25 * 60 * 60 * 1000;
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, p3.id))).details).toMatchObject({
      reason: 'approval_expired',
    });
    // An expired "Allow once" is not reused: a new card.
    const renewed = await e.svc.requestApproval(ACCOUNT, DEVICE, p3.id);
    expect(renewed.approval!.id).not.toBe(a3.approval!.id);
    expect(renewed.status).toBe('awaiting_approval');
    // A cancelled card (a Hub restart) is expired too, and a new one can be asked for.
    const p4 = await planned([{ key: 'virtualization', value: 'Disabled' }]);
    const a4 = await e.svc.requestApproval(ACCOUNT, DEVICE, p4.id);
    e.db.raw.prepare("UPDATE approval SET status = 'cancelled' WHERE id = ?").run(a4.approval!.id);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, p4.id))).details).toMatchObject({
      reason: 'approval_expired',
    });
    expect((await e.svc.requestApproval(ACCOUNT, DEVICE, p4.id)).approval!.id).not.toBe(
      a4.approval!.id,
    );
    expect(e.fake.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
  });

  it('refuses an empty plan and a change of another device', async () => {
    const same = await planned([{ key: 'wol', value: 'Disabled' }]);
    expect(same.diff).toEqual([]);
    expect((await code(e.svc.requestApproval(ACCOUNT, DEVICE, same.id))).details).toMatchObject({
      reason: 'nothing_to_apply',
    });
    expect(
      (await code(e.svc.change(ACCOUNT, DEVICE, '01920000-0000-7000-8000-0000000000ff'))).code,
    ).toBe('not_found');
  });

  it('fails on a base mismatch and writes nothing', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    e.fake.set('powerOnAfterPowerLoss', 'Last');
    const r = await code(e.svc.apply(ACCOUNT, DEVICE, plan.id));
    expect(r).toMatchObject({ code: 'conflict', details: { reason: 'base_mismatch' } });
    expect(e.fake.value('wol')).toBe('Disabled');
    const view = await e.svc.change(ACCOUNT, DEVICE, plan.id);
    expect(view).toMatchObject({ status: 'failed', error: 'conflict:base_mismatch' });
    expect(e.audit.find((a) => a.action === 'device.firmware.apply')?.result).toBe('failed');
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'failed',
    });
  });

  it('records a change whose earlier answer was lost as applied, confirmed by a read', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    // The device applied it, but the Hub never saw the answer.
    e.fake.set('wol', 'LanOnly');
    const view = await e.svc.apply(ACCOUNT, DEVICE, plan.id);
    expect(view.status).toBe('applied');
    expect(e.audit.find((a) => a.action === 'device.firmware.apply')?.detail).toMatchObject({
      confirmedByRead: true,
    });
  });

  it('marks a failed write failed, and alerts when the device could not restore', async () => {
    const plan = await approved([
      { key: 'wol', value: 'LanOnly' },
      { key: 'powerOnAfterPowerLoss', value: 'On' },
    ]);
    e.fake.failWriteOf = 'powerOnAfterPowerLoss';
    e.fake.failRestore = true;
    const r = await code(e.svc.apply(ACCOUNT, DEVICE, plan.id));
    expect(r).toMatchObject({
      code: 'server_error',
      details: { reason: 'apply_failed', restored: false },
    });
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('failed');
    expect(e.notes.at(-1)).toMatchObject({ kind: 'attention' });
  });

  it('a replayed authorization is refused by the device', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id);
    const sent = e.fake.calls.find((c) => c.path.endsWith('/apply'))!;
    const res = await fetch(`${e.fake.endpoint!}/agent/v1/firmware/apply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(sent.body),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      reason: 'replayed',
    });
    // An authorization for another kind is a mismatch.
    const res2 = await fetch(`${e.fake.endpoint!}/agent/v1/firmware/rollback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(sent.body),
    });
    expect(res2.status).toBe(403);
  });
});

describe('security-degrading changes', () => {
  beforeEach(async () => {
    e = await env();
  });

  it('are refused without the override and allowed with it, at approval and apply', async () => {
    const plan = await planned([{ key: 'secureBoot', value: 'Disabled' }]);
    expect(plan.securityDegrading).toBe(true);
    expect(plan.diff[0]).toMatchObject({ key: 'secureBoot', securityDegrading: true });
    expect(await code(e.svc.requestApproval(ACCOUNT, DEVICE, plan.id))).toEqual({
      code: 'policy_denied',
      details: {
        reason: 'security_degrading',
        keys: ['secureBoot'],
        setting: 'devices.firmware.allowSecurityDegrading',
      },
    });
    e.flags.allowSecurityDegrading = true;
    const asked = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id);
    await decide(asked);
    // Turned off again before apply: refused again.
    e.flags.allowSecurityDegrading = false;
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'security_degrading',
    });
    e.flags.allowSecurityDegrading = true;
    expect((await e.svc.apply(ACCOUNT, DEVICE, plan.id)).status).toBe('applied');
    expect(e.fake.value('secureBoot')).toBe('Disabled');
    const call = e.fake.calls.find((c) => c.path.endsWith('/apply'))!;
    expect(call.body.allowSecurityDegrading).toBe(true);
  });

  it('flags Secure Boot or the TPM turned off even when the device does not', async () => {
    await e.close();
    e = await env({
      fake: {
        settings: [
          {
            key: 'tpm',
            vendorKey: 'SecurityChip',
            value: 'Active',
            type: 'enum',
            allowed: ['Active', 'Off'],
          },
        ],
      },
    });
    const plan = await planned([{ key: 'tpm', value: 'Off' }]);
    expect(plan.securityDegrading).toBe(true);
  });
});

describe('rollback', () => {
  beforeEach(async () => {
    e = await env();
  });

  it('restores from the Hub copy when the device lost its snapshot, with an approval', async () => {
    const plan = await approved([
      { key: 'wol', value: 'LanOnly' },
      { key: 'powerOnAfterPowerLoss', value: 'Last' },
    ]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id);
    expect(e.fake.value('wol')).toBe('LanOnly');
    const snapshotId = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.id;
    const deviceSnap = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.deviceSnapshotId;
    e.fake.loseSnapshot(deviceSnap);
    const rb = await e.svc.rollback(ACCOUNT, DEVICE, snapshotId, 'back to before');
    expect(rb).toMatchObject({
      kind: 'rollback',
      status: 'awaiting_approval',
      rollbackOf: plan.id,
    });
    expect(rb.diff.find((d) => d.key === 'wol')).toMatchObject({ from: 'LanOnly', to: 'Disabled' });
    const card = e.db.raw
      .prepare('SELECT tool_name FROM approval WHERE id = ?')
      .get(rb.approval!.id) as { tool_name: string };
    expect(card.tool_name).toBe('device.firmware.rollback');
    // The same request again returns the open one.
    expect((await e.svc.rollback(ACCOUNT, DEVICE, snapshotId)).id).toBe(rb.id);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, rb.id))).code).toBe('approval_required');
    await decide(rb);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, rb.id, { reboot: true }))).details).toEqual({
      reason: 'reboot_not_offered',
    });
    const done = await e.svc.apply(ACCOUNT, DEVICE, rb.id);
    expect(done.status).toBe('applied');
    expect(e.fake.value('wol')).toBe('Disabled');
    const sent = e.fake.calls.find((c) => c.path.endsWith('/rollback'))!;
    expect(sent.body).toMatchObject({
      snapshotId: deviceSnap,
      snapshot: { sha256: expect.any(String) },
    });
    expect((sent.body.authorization as { payload: { kind: string } }).payload.kind).toBe(
      'firmware.rollback',
    );
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('rolled_back');
    const audited = e.audit.filter((a) => a.action === 'device.firmware.rollback');
    expect(audited.map((a) => a.result)).toEqual(['requested', 'ok']);
    expect(audited[1]!.detail).toMatchObject({
      before: { wol: 'LanOnly' },
      after: { wol: 'Disabled' },
    });
    // Nothing left to roll back.
    expect((await code(e.svc.rollback(ACCOUNT, DEVICE, snapshotId))).details).toMatchObject({
      reason: 'rolled_back',
    });
  });

  it('a restore that turns Secure Boot off runs with the override, flagged to the device', async () => {
    e.fake.set('secureBoot', 'Disabled');
    const on = await approved([{ key: 'secureBoot', value: 'Enabled' }]);
    await e.svc.apply(ACCOUNT, DEVICE, on.id);
    const snap = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.id;
    e.flags.allowSecurityDegrading = true;
    const rb = await e.svc.rollback(ACCOUNT, DEVICE, snap);
    expect(rb.securityDegrading).toBe(true);
    await decide(rb);
    expect((await e.svc.apply(ACCOUNT, DEVICE, rb.id)).status).toBe('applied');
    expect(e.fake.value('secureBoot')).toBe('Disabled');
    const sent = e.fake.calls.find((c) => c.path.endsWith('/rollback'))!;
    expect(sent.body.allowSecurityDegrading).toBe(true);
    // The device refuses such a restore without the flag, even with a valid authorization.
    e.fake.set('secureBoot', 'Enabled');
    const bare = authorizeDeviceBody(e.signer, {
      kind: 'firmware.rollback',
      deviceId: DEVICE,
      approvalId: rb.approval!.id,
      body: { snapshotId: sent.body.snapshotId, snapshot: sent.body.snapshot },
      now: new Date(e.clock.now),
    });
    const res = await fetch(`${e.fake.endpoint!}/agent/v1/firmware/rollback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(bare),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      reason: 'security_degrading',
    });
  });

  it('refuses a snapshot whose change never ran, an unknown one, and a degrading restore', async () => {
    const plan = await planned([{ key: 'wol', value: 'LanOnly' }]);
    const snapshotId = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.id;
    expect((await code(e.svc.rollback(ACCOUNT, DEVICE, snapshotId))).details).toMatchObject({
      reason: 'nothing_to_roll_back',
    });
    expect((await code(e.svc.rollback(ACCOUNT, DEVICE, plan.id))).code).toBe('not_found');
    // Secure Boot was off when planned; turning it on, then rolling back, would turn it off.
    e.fake.set('secureBoot', 'Disabled');
    e.flags.allowSecurityDegrading = false;
    const on = await approved([{ key: 'secureBoot', value: 'Enabled' }]);
    await e.svc.apply(ACCOUNT, DEVICE, on.id);
    const snap = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.id;
    expect((await code(e.svc.rollback(ACCOUNT, DEVICE, snap))).details).toMatchObject({
      reason: 'security_degrading',
    });
    // A tampered Hub copy is refused before anything is sent.
    const row = e.db.raw
      .prepare('SELECT blob_path FROM firmware_snapshot WHERE id = ?')
      .get(snap) as {
      blob_path: string;
    };
    rmSync(join(e.dir, row.blob_path));
    expect((await code(e.svc.rollback(ACCOUNT, DEVICE, snap))).details).toMatchObject({
      reason: 'snapshot_unreadable',
    });
    expect(e.svc.snapshotCopyExists(snap)).toBe(false);
  });
});

describe('a Hub-only card (docs/23 §6.3)', () => {
  beforeEach(async () => {
    e = await env();
  });

  it('is answered by the signed-in user only: a channel, a hook or a link is refused', async () => {
    const gate = new PolicyGate({
      store: new PolicyStore({ db: e.db }),
      events: e.events,
      audit: { append: (r) => (e.audit.push(r), Promise.resolve()) },
      notifier: { notify: () => Promise.resolve() },
      setting: (key) => Promise.resolve(SETTINGS[key].default as never),
      dataDir: join(e.dir, 'data'),
      home: join(e.dir, 'home'),
    });
    const plan = await planned([{ key: 'wol', value: 'LanOnly' }]);
    const asked = await e.svc.requestApproval(ACCOUNT, DEVICE, plan.id);
    const approvalId = asked.approval!.id;
    expect(e.db.raw.prepare('SELECT answer_in FROM approval WHERE id = ?').get(approvalId)).toEqual(
      { answer_in: 'hub' },
    );
    for (const by of ['channel:b1', 'hook:h1', 'system']) {
      expect(await code(gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }, by))).toEqual({
        code: 'policy_denied',
        details: { reason: 'hub_only' },
      });
    }
    // The UI path (POST /api/v1/approvals, decided by `user`) answers it; then apply runs.
    const view = await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }, 'user');
    expect(view).toMatchObject({ decision: 'allow_once', decidedBy: 'user', answerIn: 'hub' });
    await e.svc.onApprovalDecided(ACCOUNT, approvalId, 'allow_once');
    expect((await e.svc.apply(ACCOUNT, DEVICE, plan.id)).status).toBe('applied');
  });
});

describe('the watchdog', () => {
  beforeEach(async () => {
    e = await env();
  });

  it('a reverted event marks the change reverted and tells the owner', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    const applied = await e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true });
    expect(applied).toMatchObject({ reboot: true, watchdog: { state: 'pending' } });
    expect(e.fake.reboots).toBe(1);
    e.fake.bootFailed();
    expect(e.fake.value('wol')).toBe('Disabled');
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      { kind: 'device.module.changed' },
      'junk',
      ...e.fake.events.splice(0),
    ]);
    const view = await e.svc.change(ACCOUNT, DEVICE, plan.id);
    expect(view).toMatchObject({ status: 'reverted', watchdog: { state: 'reverted' } });
    expect(e.notes.at(-1)).toMatchObject({ kind: 'attention', title: 'Firmware change reverted' });
    const w = e.audit.find((a) => a.action === 'device.firmware.watchdog')!;
    expect(w).toMatchObject({ actor: 'system', result: 'reverted' });
    expect(w.detail).toMatchObject({ before: { wol: 'LanOnly' }, after: { wol: 'Disabled' } });
    // A repeat of the event changes nothing.
    const n = e.notes.length;
    const deviceSnap = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.deviceSnapshotId;
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      { kind: 'firmware.watchdog.reverted', snapshotId: deviceSnap },
    ]);
    expect(e.notes.length).toBe(n);
  });

  it('a failed revert is revert_failed: told truthfully, and rollback stays open', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true });
    e.fake.failRestore = true;
    e.fake.bootFailed();
    const events = e.fake.events.splice(0);
    // novad's shape: `complete: false`, every key in `failed`, no reboot.
    expect(events[0]).toMatchObject({
      changeId: expect.any(String),
      detail: {
        complete: false,
        restored: [],
        failed: [{ key: 'wol', from: 'LanOnly', to: 'Disabled', error: 'write_failed' }],
        rebooted: false,
      },
    });
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, events);
    expect(await e.svc.change(ACCOUNT, DEVICE, plan.id)).toMatchObject({
      status: 'revert_failed',
      watchdog: { state: 'revert_failed' },
      error: 'watchdog:write_failed',
    });
    expect(e.fake.value('wol')).toBe('LanOnly');
    expect(e.notes.at(-1)).toMatchObject({
      kind: 'attention',
      title: 'A firmware change could not be reverted',
    });
    // The audit says the change is still there.
    expect(e.audit.find((a) => a.action === 'device.firmware.watchdog')).toMatchObject({
      result: 'revert_failed',
      detail: {
        before: { wol: 'LanOnly' },
        after: { wol: 'LanOnly' },
        notRestored: ['wol'],
        failed: [{ key: 'wol', error: 'write_failed' }],
        errorCode: 'write_failed',
      },
    });
    // A repeat changes nothing; the owner can still roll back from the Hub copy.
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, events);
    expect(e.audit.filter((a) => a.action === 'device.firmware.watchdog')).toHaveLength(1);
    e.fake.failRestore = false;
    const snapshotId = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.id;
    const rb = await e.svc.rollback(ACCOUNT, DEVICE, snapshotId);
    expect(rb.status).toBe('awaiting_approval');
    await decide(rb);
    expect((await e.svc.apply(ACCOUNT, DEVICE, rb.id)).status).toBe('applied');
    expect(e.fake.value('wol')).toBe('Disabled');
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('rolled_back');
  });

  it('matches a report by the change id of the apply that armed it, by snapshot without one', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true });
    e.fake.bootOk();
    const [ok] = e.fake.events.splice(0);
    // Another change id with this snapshot is not this change's report.
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      { ...ok, changeId: '01920000-0000-7000-8000-0000000000cc' },
    ]);
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).watchdog?.state).toBe('pending');
    const row = e.db.raw.prepare('SELECT change_id FROM firmware_change WHERE id = ?').get(plan.id);
    expect(ok!.changeId).toBe((row as { change_id: string }).change_id);
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [ok]);
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).watchdog?.state).toBe('ok');
    // An older novad without change ids: the snapshot names it.
    const p2 = await approved([{ key: 'powerOnAfterPowerLoss', value: 'On' }]);
    await e.svc.apply(ACCOUNT, DEVICE, p2.id, { reboot: true });
    e.fake.omitChangeId = true;
    e.fake.bootFailed();
    const legacy = e.fake.events.splice(0);
    expect(legacy[0]).not.toHaveProperty('changeId');
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, legacy);
    expect((await e.svc.change(ACCOUNT, DEVICE, p2.id)).status).toBe('reverted');
  });

  it('a partial or unreadable revert report is not taken as a revert', async () => {
    const plan = await approved([
      { key: 'wol', value: 'LanOnly' },
      { key: 'powerOnAfterPowerLoss', value: 'On' },
    ]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true });
    const snap = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.deviceSnapshotId;
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      {
        kind: 'firmware.watchdog.reverted',
        snapshotId: snap,
        detail: {
          reason: 'deadline',
          restored: [{ key: 'wol', from: 'LanOnly', to: 'Disabled' }],
          failed: [{ key: 'powerOnAfterPowerLoss', from: 'On', to: 'Off', error: 'io' }],
          rebooted: false,
        },
      },
    ]);
    const w = e.audit.find((a) => a.action === 'device.firmware.watchdog')!;
    expect(w.result).toBe('revert_failed');
    expect(w.detail).toMatchObject({
      after: { wol: 'Disabled', powerOnAfterPowerLoss: 'On' },
      notRestored: ['powerOnAfterPowerLoss'],
    });
    const p2 = await approved([{ key: 'virtualization', value: 'Disabled' }]);
    await e.svc.apply(ACCOUNT, DEVICE, p2.id, { reboot: true });
    const s2 = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.deviceSnapshotId;
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      { kind: 'firmware.watchdog.reverted', snapshotId: s2, detail: 'no heartbeat' },
    ]);
    expect((await e.svc.change(ACCOUNT, DEVICE, p2.id)).status).toBe('revert_failed');
    // `complete: false` is never a revert, even when every key looks restored.
    const p3 = await approved([
      { key: 'fanProfile', value: 'Quiet' },
      { key: 'wol', value: 'LanWlan' },
    ]);
    await e.svc.apply(ACCOUNT, DEVICE, p3.id, { reboot: true });
    const s3 = (await e.svc.history(ACCOUNT, DEVICE)).snapshots[0]!.deviceSnapshotId;
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      {
        kind: 'firmware.watchdog.reverted',
        snapshotId: s3,
        detail: {
          reason: 'deadline',
          complete: false,
          restored: [{ key: 'wol', from: 'LanWlan', to: 'Disabled' }],
          failed: [],
          rebooted: false,
        },
      },
    ]);
    expect((await e.svc.change(ACCOUNT, DEVICE, p3.id)).status).toBe('revert_failed');
  });

  it("arms the device's watchdog for the owner's length, inside novad's range", async () => {
    e.flags.watchdogSeconds = 900;
    const p1 = await approved([{ key: 'wol', value: 'LanOnly' }]);
    const v1 = await e.svc.apply(ACCOUNT, DEVICE, p1.id, { reboot: true });
    const sent = e.fake.calls.filter((c) => c.path.endsWith('/apply'));
    expect(sent.at(-1)!.body.watchdogSeconds).toBe(900);
    expect(e.fake.lastWatchdogSeconds).toBe(900);
    expect(v1.watchdog?.deadline).toBe(new Date(e.clock.now + 900_000).toISOString());
    e.fake.bootOk();
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, e.fake.events.splice(0));
    // A stored value outside the range is kept inside it; no restart, no watchdog length.
    for (const [stored, sentAs] of [
      [30, 120],
      [99_999, 3600],
      [undefined, 600],
    ] as const) {
      e.flags.watchdogSeconds = stored;
      const p = await approved([
        {
          key: 'virtualization',
          value: e.fake.value('virtualization') === 'Enabled' ? 'Disabled' : 'Enabled',
        },
      ]);
      await e.svc.apply(ACCOUNT, DEVICE, p.id, { reboot: true });
      expect(
        e.fake.calls.filter((c) => c.path.endsWith('/apply')).at(-1)!.body.watchdogSeconds,
      ).toBe(sentAs);
      e.fake.bootOk();
      await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, e.fake.events.splice(0));
    }
    const p3 = await approved([{ key: 'powerOnAfterPowerLoss', value: 'On' }]);
    await e.svc.apply(ACCOUNT, DEVICE, p3.id);
    expect(e.fake.calls.filter((c) => c.path.endsWith('/apply')).at(-1)!.body).not.toHaveProperty(
      'watchdogSeconds',
    );
  });

  it('words the notice by what happened: never restarted, or restarted and not back', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true });
    const row = e.db.raw
      .prepare('SELECT change_id FROM firmware_change WHERE id = ?')
      .get(plan.id) as {
      change_id: string;
    };
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      {
        kind: 'firmware.watchdog.reverted',
        changeId: row.change_id,
        detail: {
          reason: 'not_restarted',
          complete: true,
          restored: [{ key: 'wol', from: 'LanOnly', to: 'Disabled' }],
          failed: [],
          rebooted: false,
        },
      },
    ]);
    expect(e.notes.at(-1)).toMatchObject({
      title: 'Firmware change reverted',
      body: 'desk did not restart before the watchdog deadline, so the watchdog restored the previous settings without a restart.',
    });
    expect(e.notes.at(-1)!.body).not.toContain('come back');
    // The change records novad's reason, so the card can say the same (J9.5).
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).watchdog).toMatchObject({
      state: 'reverted',
      reason: 'not_restarted',
    });
  });

  it('an ok event confirms the change; no report by the deadline is missed', async () => {
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    await e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true });
    e.fake.bootOk();
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, e.fake.events.splice(0));
    expect(await e.svc.change(ACCOUNT, DEVICE, plan.id)).toMatchObject({
      status: 'applied',
      watchdog: { state: 'ok' },
    });
    expect(e.notes.at(-1)?.title).toBe('Firmware change confirmed');

    const p2 = await approved([{ key: 'powerOnAfterPowerLoss', value: 'On' }]);
    await e.svc.apply(ACCOUNT, DEVICE, p2.id, { reboot: true });
    expect(await e.svc.sweep()).toEqual([]);
    e.clock.now += 600_000 + 121_000;
    expect(await e.svc.sweep()).toEqual([p2.id]);
    expect((await e.svc.change(ACCOUNT, DEVICE, p2.id)).watchdog?.state).toBe('missed');
    expect(e.notes.at(-1)?.title).toBe('A device has not come back after a firmware change');
    // A late ok still confirms it.
    e.fake.bootOk();
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, e.fake.events.splice(0));
    expect((await e.svc.change(ACCOUNT, DEVICE, p2.id)).watchdog?.state).toBe('ok');
    // An event naming no known snapshot, or another account's device, is ignored.
    await e.svc.onHeartbeatEvents(ACCOUNT, DEVICE, [
      { kind: 'firmware.watchdog.ok', snapshotId: 'nope' },
    ]);
    const p3 = await approved([{ key: 'virtualization', value: 'Disabled' }]);
    await e.svc.apply(ACCOUNT, DEVICE, p3.id, { reboot: true });
    e.fake.bootFailed();
    await e.svc.onHeartbeatEvents(OTHER, DEVICE, e.fake.events.splice(0));
    expect((await e.svc.change(ACCOUNT, DEVICE, p3.id)).status).toBe('applied');
  });
});

describe('unsupported hardware and the channel', () => {
  it('refuses writes on a machine the device reports unsupported', async () => {
    e = await env({ fake: { supported: false, reason: 'no firmware-attributes driver' } });
    const r = await e.svc.read(ACCOUNT, DEVICE);
    expect(r).toMatchObject({ supported: false, reason: 'no firmware-attributes driver' });
    expect(await code(planned([{ key: 'wol', value: 'LanOnly' }]))).toEqual({
      code: 'conflict',
      details: { reason: 'unsupported_hardware', detail: 'no firmware-attributes driver' },
    });
    expect(e.fake.calls.some((c) => c.path.endsWith('/plan'))).toBe(false);
  });

  it('refuses vendors the matrix refuses and other operating systems, whatever the device says', async () => {
    e = await env({ fake: { platform: { vendor: 'ASUSTeK COMPUTER INC.' } } });
    expect((await e.svc.read(ACCOUNT, DEVICE)).supported).toBe(false);
    expect((await code(planned([{ key: 'wol', value: 'LanOnly' }]))).details).toMatchObject({
      reason: 'unsupported_hardware',
    });
    await e.close();
    e = await env({ os: 'windows' });
    expect((await e.svc.read(ACCOUNT, DEVICE)).reason).toBe('os_not_supported');
  });

  it("turns novad's unsupported_hardware answer into a conflict", async () => {
    let refuse = false;
    const transport: DeviceTransport = {
      async post(url, token, body, timeoutMs, target) {
        if (refuse && url.endsWith('/plan'))
          return {
            status: 409,
            body: { error: { code: 'unsupported_hardware', details: { reason: 'BIOS too old' } } },
          };
        return httpDeviceTransport.post(url, token, body, timeoutMs, target);
      },
    };
    e = await env({ svc: { transport } });
    refuse = true;
    expect(await code(planned([{ key: 'wol', value: 'LanOnly' }]))).toMatchObject({
      code: 'conflict',
      details: { reason: 'unsupported_hardware', detail: 'BIOS too old' },
    });
  });

  it('never calls an https device without the mutual TLS transport', async () => {
    e = await env();
    e.device.endpoint = e.device.endpoint!.replace('http:', 'https:');
    expect(await code(e.svc.read(ACCOUNT, DEVICE))).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'device_tls_failed', tls: 'no_client_certificate' },
    });
    // With one, the call goes through it (here back to the plain fake).
    let used = 0;
    e.svc.useTlsTransport({
      post: (url, ...rest) => {
        used += 1;
        return httpDeviceTransport.post(url.replace('https:', 'http:'), ...rest);
      },
    });
    expect((await e.svc.read(ACCOUNT, DEVICE)).supported).toBe(true);
    expect(used).toBe(1);
    // Or through the devices area's own client.
    e.svc.useDeviceCall(() => Promise.resolve({ supported: false, reason: 'via devices' }));
    expect((await e.svc.read(ACCOUNT, DEVICE, { fresh: true })).reason).toBe('via devices');
  });

  it('refuses a revoked device as unknown and an unreachable one as unavailable', async () => {
    e = await env();
    e.device.row.status = 'unreachable';
    expect((await code(e.svc.read(ACCOUNT, DEVICE))).code).toBe('node_unavailable');
    e.device.row.status = 'revoked';
    expect((await code(e.svc.read(ACCOUNT, DEVICE))).code).toBe('not_found');
    expect((await code(e.svc.history(ACCOUNT, DEVICE))).code).toBe('not_found');
  });

  it('refuses to sign without the Hub identity', async () => {
    e = await env({ svc: { identity: () => null } });
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'identity_unavailable',
    });
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('approved');
  });
});

/** Route the device's https endpoint to the fake, as a mutual TLS channel would reach novad. */
function overMutualTls(): void {
  e.device.endpoint = e.device.endpoint!.replace('http:', 'https:');
  e.svc.useTlsTransport({
    post: (url, ...rest) => httpDeviceTransport.post(url.replace('https:', 'http:'), ...rest),
  });
  e.fake.transport = 'mutual_tls';
}

/** Every vault read of the BIOS password. */
function passwordReads(): string[] {
  const reads: string[] = [];
  const get = e.secrets.get.bind(e.secrets);
  e.secrets.get = (ref: string) => {
    if (ref === biosPasswordRef(DEVICE)) reads.push(ref);
    return get(ref);
  };
  return reads;
}

describe('the BIOS admin password', () => {
  it('is never read from the vault or sent unless the channel is mutual TLS', async () => {
    e = await env({ fake: { adminPassword: 'correct horse' } });
    await e.svc.setAdminPassword(ACCOUNT, DEVICE, 'correct horse');
    const reads = passwordReads();
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    expect(await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).toEqual({
      code: 'policy_denied',
      details: { reason: 'tls_required' },
    });
    expect(reads).toEqual([]);
    expect(e.fake.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
    // Nothing final: once the device is reached over mutual TLS the same approval works.
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('approved');
    // novad itself refuses a password that arrives over plain HTTP.
    const res = await fetch(`${e.fake.endpoint!}/agent/v1/firmware/apply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        authorizeDeviceBody(e.signer, {
          kind: 'firmware.apply',
          deviceId: DEVICE,
          approvalId: 'a',
          body: { planId: 'p', snapshotId: 's', changes: [], adminPassword: 'x' },
          now: new Date(e.clock.now),
        }),
      ),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      reason: 'tls_required',
    });
    overMutualTls();
    expect((await e.svc.apply(ACCOUNT, DEVICE, plan.id)).status).toBe('applied');
    expect(reads).toHaveLength(1);
  });

  it('over mutual TLS: needed, sent per call, never hashed, stored or audited', async () => {
    e = await env({ fake: { adminPassword: 'correct horse' } });
    overMutualTls();
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'bios_password_required',
    });
    expect(await e.svc.setAdminPassword(ACCOUNT, DEVICE, 'correct horse')).toEqual({
      stored: true,
    });
    expect(await e.secrets.get(biosPasswordRef(DEVICE))).toBe('correct horse');
    expect(await e.svc.adminPasswordStored(DEVICE)).toBe(true);
    expect((await e.svc.apply(ACCOUNT, DEVICE, plan.id)).status).toBe('applied');
    const sent = e.fake.calls.find((c) => c.path.endsWith('/apply'))!;
    expect(sent.body.adminPassword).toBe('correct horse');
    const { adminPassword: _pw, authorization, ...rest } = sent.body;
    void _pw;
    expect((authorization as { payload: { bodySha256: string } }).payload.bodySha256).toBe(
      deviceAuthzBodySha256(rest),
    );
    expect(JSON.stringify(e.audit)).not.toContain('correct horse');
    const dump = JSON.stringify(e.db.raw.prepare('SELECT * FROM firmware_change').all());
    expect(dump).not.toContain('correct horse');
    expect(e.audit.find((a) => a.action === 'device.firmware.password.set')?.kind).toBe('secret');
    expect(await e.svc.setAdminPassword(ACCOUNT, DEVICE, null)).toEqual({ stored: false });
    expect(await e.svc.adminPasswordStored(DEVICE)).toBe(false);
  });

  it('refuses a guarded reboot: the watchdog cannot restore without the password', async () => {
    e = await env({ fake: { adminPassword: 'pw' } });
    overMutualTls();
    await e.svc.setAdminPassword(ACCOUNT, DEVICE, 'pw');
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    expect(await code(e.svc.apply(ACCOUNT, DEVICE, plan.id, { reboot: true }))).toEqual({
      code: 'policy_denied',
      details: { reason: 'watchdog_unavailable', detail: 'admin_password_set' },
    });
    expect(e.fake.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
    expect((await e.svc.apply(ACCOUNT, DEVICE, plan.id)).status).toBe('applied');
    expect(e.fake.reboots).toBe(0);
  });

  it('a wrong password fails the change on the device and nothing changes', async () => {
    e = await env({ fake: { adminPassword: 'right' } });
    overMutualTls();
    await e.svc.setAdminPassword(ACCOUNT, DEVICE, 'wrong');
    const plan = await approved([{ key: 'wol', value: 'LanOnly' }]);
    expect((await code(e.svc.apply(ACCOUNT, DEVICE, plan.id))).details).toMatchObject({
      reason: 'apply_failed',
      restored: true,
    });
    expect(e.fake.value('wol')).toBe('Disabled');
    expect((await e.svc.change(ACCOUNT, DEVICE, plan.id)).status).toBe('failed');
    expect(existsSync(e.dir)).toBe(true);
  });

  it('leaves the vault when the device is revoked or decommissioned', async () => {
    e = await env();
    await e.svc.setAdminPassword(ACCOUNT, DEVICE, 'pw');
    await e.revoke();
    expect(await e.svc.adminPasswordStored(DEVICE)).toBe(false);
    expect(e.audit.at(-1)).toMatchObject({
      action: 'device.firmware.password.clear',
      kind: 'secret',
      actor: 'system',
      detail: { reason: 'device_revoked' },
    });
    // Nothing stored: nothing to do, nothing audited.
    const n = e.audit.length;
    await e.revoke();
    expect(e.audit.length).toBe(n);
    e.svc.close();
    await e.svc.setAdminPassword(ACCOUNT, DEVICE, 'pw');
    await e.revoke();
    expect(await e.svc.adminPasswordStored(DEVICE)).toBe(true);
  });
});

describe('the watchdog notice', () => {
  it('says what novad reported, for each reason and outcome', () => {
    expect(watchdogNotice('desk', 'deadline', true, null, true)).toEqual({
      title: 'Firmware change reverted',
      body: 'desk restarted into the firmware change but was not back in time, so the watchdog restored the previous settings and restarted it.',
    });
    expect(watchdogNotice('desk', 'deadline', false, 'admin_password_required', false).body).toBe(
      'desk restarted into the firmware change but was not back in time, and the watchdog could not restore the previous settings (admin_password_required). Roll it back from Nova or check its firmware.',
    );
    expect(watchdogNotice('desk', 'not_restarted', false, null, false)).toEqual({
      title: 'A firmware change could not be reverted',
      body: 'desk did not restart before the watchdog deadline, and the watchdog could not restore the previous settings. Roll it back from Nova or check its firmware.',
    });
    expect(watchdogNotice('desk', null, true, null, false).body).toBe(
      'On desk, the watchdog restored the previous settings.',
    );
    expect(watchdogNotice('desk', 'later', false, 'x', false).body).toBe(
      'On desk, the watchdog could not restore the previous settings (x). Roll it back from Nova or check its firmware.',
    );
  });

  it('reads an unknown backend name as sent, never failing the answer', async () => {
    e = await env({
      svc: {
        call: () =>
          Promise.resolve({
            supported: true,
            method: 'quantum-bios',
            settings: [],
            platform: null,
          }),
      },
    });
    expect((await e.svc.read(ACCOUNT, DEVICE)).method).toBe('quantum-bios');
    e.svc.useDeviceCall(() =>
      Promise.resolve({ supported: true, method: '<script>', settings: [] }),
    );
    expect((await e.svc.read(ACCOUNT, DEVICE, { fresh: true })).method).toBe('unreadable');
    e.svc.useDeviceCall(() => Promise.resolve({ supported: false }));
    expect((await e.svc.read(ACCOUNT, DEVICE, { fresh: true })).method).toBeNull();
  });
});
