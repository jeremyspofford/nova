// secret-scan: fake-file (the BMC credentials below are made-up fixtures)
// Out-of-band management on the Hub (FR-147; docs/23 §7; ADR-043, ADR-096 D6) with a real
// database, the vault, a fake Redfish BMC over HTTPS on 127.0.0.1 and a fake ipmitool: off by
// default, owner only, AMT refused, credentials only in the vault, the BMC certificate pinned on
// first use and a different one refused and audited, approvals for everything but the read
// actions (confirm-at-action cards, run only after allow_once within their time), BIOS plans that
// follow the firmware toggles with a diff, a snapshot check and one apply, one-time boot, and the
// boot area's power-cycle seam.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  isNovaError,
  uuidv7,
  type OobActionView,
  type OobBiosPlanView,
} from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { MemoryEventSink } from '../src/events.ts';
import { OOB_APPROVAL_TTL_MS, OobService, oobCredentialRef } from '../src/oob/service.ts';
import type { AuditRecord, NotificationInput } from '../src/tools/types.ts';
import { startFakeRedfish, type FakeBmc } from './fixtures/oob/fake-redfish.ts';
import { fakeIpmi } from './fixtures/oob/ipmi.ts';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const MEMBER = '01920000-0000-7000-8000-0000000000a2';
const CREDS = { username: 'root', password: 'calvin-secret-9' };

let dir: string;
let db: NovaDatabase;
let bmc: FakeBmc;
let ipmi: ReturnType<typeof fakeIpmi>;
let secrets: MemorySecretStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let notes: NotificationInput[];
let flags: { enabled: boolean; firmware: boolean; degrading: boolean };
let clock: Date;
let svc: OobService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-oob-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [OWNER, MEMBER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  bmc = await startFakeRedfish();
  ipmi = fakeIpmi(dir);
  secrets = new MemorySecretStore();
  events = new MemoryEventSink();
  audit = [];
  notes = [];
  flags = { enabled: false, firmware: false, degrading: false };
  clock = new Date('2026-10-19T10:00:00.000Z');
  svc = new OobService({
    db,
    secrets,
    events,
    log: new Logger({ module: 'oob', sinks: [new MemorySink()] }),
    settings: {
      enabled: () => Promise.resolve(flags.enabled),
      firmwareAllowChanges: () => Promise.resolve(flags.firmware),
      firmwareAllowSecurityDegrading: () => Promise.resolve(flags.degrading),
    },
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    now: () => clock,
    runner: ipmi.runner,
    timeoutMs: 3000,
    isOwner: (id) => id === OWNER,
    allowLoopbackForTests: true,
  });
});

afterEach(async () => {
  await bmc.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function failure(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) return err;
    // The Hub answers a schema failure as 400 `validation`.
    if (err instanceof z.ZodError) return new NovaError('validation', err.message);
    throw err;
  }
  throw new Error('expected a failure');
}

/** A Redfish endpoint whose pin the owner entered (so confirmed). */
function redfish(over: Record<string, unknown> = {}) {
  return svc.create(OWNER, {
    name: 'rack-1',
    kind: 'redfish',
    address: bmc.host,
    port: bmc.port,
    credentials: CREDS,
    tlsPin: bmc.pin,
    ...over,
  });
}

/** A Redfish endpoint without a pin: the first check reads it, the owner confirms it. */
function unpinned(over: Record<string, unknown> = {}) {
  return redfish({ tlsPin: undefined, ...over });
}

function ipmiEndpoint(over: Record<string, unknown> = {}) {
  return svc.create(OWNER, {
    name: 'old-box',
    kind: 'ipmi',
    address: '127.0.0.1',
    credentials: { username: 'admin', password: 'ipmi-secret-7' },
    ...over,
  });
}

/** Answer a card the way the approvals gate records a decision, then tell the service. */
async function decide(approvalId: string, decision: string): Promise<void> {
  db.raw
    .prepare(
      "UPDATE approval SET status = 'decided', decision = ?, decided_by = 'user', decided_at = ? WHERE id = ?",
    )
    .run(decision, clock.toISOString(), approvalId);
  await svc.onApprovalDecided(OWNER, approvalId);
}

const actions = (name: string) => audit.filter((a) => a.action === name);
const posts = () => bmc.requests.filter((r) => r.method !== 'GET');

describe('enabling and who may act', () => {
  it('is off by default: nothing is created or asked of a BMC', async () => {
    expect((await svc.status(OWNER)).enabled).toBe(false);
    const err = await failure(redfish());
    expect(err.code).toBe('oob_disabled');
    expect(await svc.list(OWNER)).toEqual([]);
    flags.enabled = true;
    const ep = await redfish();
    flags.enabled = false;
    expect((await failure(svc.act(OWNER, ep.id, 'power.status', {}))).code).toBe('oob_disabled');
    expect((await failure(svc.update(OWNER, ep.id, { name: 'x' }))).code).toBe('oob_disabled');
    expect(bmc.requests).toEqual([]);
    expect(actions('device.oob.refuse').map((a) => a.detail?.reason)).toEqual([
      'oob_disabled',
      'oob_disabled',
      'oob_disabled',
    ]);
    // Deleting (and so removing the credentials) works while it is off.
    await svc.remove(OWNER, ep.id);
    expect(await secrets.has(oobCredentialRef(ep.id))).toBe(false);
  });

  it('refuses a member everything, audited', async () => {
    flags.enabled = true;
    const ep = await redfish();
    for (const p of [
      svc.status(MEMBER),
      svc.list(MEMBER),
      svc.get(MEMBER, ep.id),
      svc.create(MEMBER, { name: 'x', kind: 'redfish', address: '10.0.0.1', credentials: CREDS }),
      svc.act(MEMBER, ep.id, 'power.cycle', {}),
      svc.listActions(MEMBER),
      svc.remove(MEMBER, ep.id),
    ]) {
      const err = await failure(p);
      expect(err.code).toBe('policy_denied');
      expect(err.details?.reason).toBe('owner_only');
    }
    expect(actions('device.oob.refuse').every((a) => a.accountId === MEMBER)).toBe(true);
    expect(actions('device.oob.refuse')).toHaveLength(7);
    expect(await svc.powerCycleFor(MEMBER, uuidv7())).toBeNull();
    expect(bmc.requests).toEqual([]);
  });

  it('refuses Intel AMT as not built', async () => {
    flags.enabled = true;
    const err = await failure(
      svc.create(OWNER, { name: 'vpro', kind: 'amt', address: '10.0.0.7', credentials: CREDS }),
    );
    expect(err.code).toBe('capability_missing');
    expect(err.details?.reason).toBe('not_built');
    expect((await svc.status(OWNER)).kinds.amt).toEqual({ built: false, reason: 'not_built' });
  });
});

describe('the registry', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  it('keeps credentials only in the vault', async () => {
    const ep = await unpinned({ address: `https://${bmc.host}:${bmc.port}/`, port: undefined });
    expect(ep).toMatchObject({
      kind: 'redfish',
      address: '127.0.0.1',
      port: bmc.port,
      credentialRef: `secret://oob/${ep.id}`,
      hasCredentials: true,
      tlsPin: null,
      supported: true,
    });
    expect(JSON.parse((await secrets.get(ep.credentialRef))!)).toEqual(CREDS);
    const dump = JSON.stringify([
      db.raw.prepare('SELECT * FROM oob_endpoint').all(),
      audit,
      events.events,
      ep,
    ]);
    expect(dump).not.toContain(CREDS.password);
    expect(dump).not.toContain(CREDS.username);
    expect(events.names()).toContain('device.oob.endpoint.changed');
    expect(actions('device.oob.endpoint.create')).toHaveLength(1);
  });

  it('validates addresses, ports, links and protocol fields', async () => {
    const bad = [
      { address: 'https://root:pw@10.0.0.1' },
      { address: '10.0.0.1:8443', port: 443 },
      { deviceId: uuidv7() },
      { kind: 'ipmi', systemId: 'x' },
      { kind: 'ipmi', tlsPin: 'a'.repeat(64) },
      { tlsPin: 'nothex' },
      { credentials: { username: 'ro:ot', password: 'x' } },
      { address: 'localhost' },
      { address: '169.254.10.1' },
      { address: '0x7f000001' },
      // A URL's numeric host is normalized (to 169.254.1.1, link-local) and then refused.
      { address: 'https://0xa9fe0101/' },
    ];
    for (const over of bad) expect((await failure(redfish(over))).code).toBe('validation');
    const deviceId = uuidv7();
    const iso = clock.toISOString();
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, created_at, updated_at)
         VALUES (?, ?, 'server', 'client', ?, 'k', '[]', 'active', ?, ?)`,
      )
      .run(deviceId, OWNER, `fp-${deviceId}`, iso, iso);
    const ep = await redfish({
      deviceId,
      tlsPin: bmc.pin.toUpperCase().replace(/(..)(?!$)/g, '$1:'),
    });
    expect(ep.deviceId).toBe(deviceId);
    expect(ep.tlsPin).toBe(bmc.pin);
    expect(ep.tlsPinnedAt).toBe(clock.toISOString());
  });

  it('updates: a new address forgets the pin; new credentials replace the vault entry', async () => {
    const ep = await redfish({ tlsPin: bmc.pin });
    const renamed = await svc.update(OWNER, ep.id, {
      name: 'rack-1a',
      systemId: 'System.Embedded.1',
    });
    expect(renamed).toMatchObject({
      name: 'rack-1a',
      tlsPin: bmc.pin,
      systemId: 'System.Embedded.1',
    });
    await svc.update(OWNER, ep.id, {
      credentials: { username: 'root', password: 'new-password-1' },
    });
    expect(JSON.parse((await secrets.get(ep.credentialRef))!)).toMatchObject({
      password: 'new-password-1',
    });
    const moved = await svc.update(OWNER, ep.id, { address: 'bmc-2.lab:8443' });
    expect(moved).toMatchObject({ address: 'bmc-2.lab', port: 8443, tlsPin: null });
    const repinned = await svc.update(OWNER, ep.id, {
      address: '127.0.0.1',
      port: bmc.port,
      tlsPin: bmc.pin,
    });
    expect(repinned.tlsPin).toBe(bmc.pin);
    const upd = actions('device.oob.endpoint.update');
    expect(upd).toHaveLength(4);
    expect(upd[1]?.detail?.credentials).toBe('replaced');
    expect(upd[2]?.detail?.before).toMatchObject({ address: '127.0.0.1', tlsPin: bmc.pin });
    expect(upd[2]?.detail?.after).toMatchObject({ address: 'bmc-2.lab', tlsPin: null });
    expect(JSON.stringify(audit)).not.toContain('new-password-1');
    expect((await failure(svc.update(OWNER, ep.id, { address: 'x:1', port: 2 }))).code).toBe(
      'validation',
    );
    expect((await failure(svc.get(OWNER, uuidv7()))).code).toBe('not_found');
  });
});

describe('Redfish: the certificate pin', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  it('a first check reads the pin without credentials; only the confirmed pin unlocks them', async () => {
    const ep = await unpinned();
    expect(ep).toMatchObject({ tlsPin: null, tlsPinConfirmed: false });
    const first = await svc.act(OWNER, ep.id, 'check', {});
    expect(first.action).toMatchObject({
      status: 'done',
      result: {
        protocol: 'redfish',
        vendor: 'Dell',
        tlsPin: bmc.pin,
        pinConfirmed: false,
        authenticated: false,
        systems: null,
      },
    });
    expect(await svc.get(OWNER, ep.id)).toMatchObject({ tlsPin: bmc.pin, tlsPinConfirmed: false });
    expect(actions('device.oob.pin')[0]).toMatchObject({ decision: 'unconfirmed' });
    // Every other action waits for the confirmation; nothing carried the credentials.
    for (const action of ['power.status', 'sensors', 'bios.read', 'power.cycle'] as const) {
      const err = await failure(svc.act(OWNER, ep.id, action, {}));
      expect(err.details).toMatchObject({ reason: 'pin_unconfirmed', tlsPin: bmc.pin });
    }
    await svc.act(OWNER, ep.id, 'check', {});
    expect(bmc.requests.every((r) => !r.sentCredentials)).toBe(true);
    expect(db.raw.prepare('SELECT count(*) AS n FROM approval').get()).toEqual({ n: 0 });
    // Confirming another fingerprint is refused; the right one unlocks the credentials.
    const wrong = await failure(svc.confirmPin(OWNER, ep.id, { tlsPin: 'cd'.repeat(32) }));
    expect(wrong.details?.reason).toBe('pin_changed');
    expect(
      (await failure(svc.confirmPin(MEMBER, ep.id, { tlsPin: bmc.pin }))).details?.reason,
    ).toBe('owner_only');
    const confirmed = await svc.confirmPin(OWNER, ep.id, {
      tlsPin: bmc.pin.toUpperCase().replace(/(..)(?!$)/g, '$1:'),
    });
    expect(confirmed).toMatchObject({
      tlsPinConfirmed: true,
      tlsPinConfirmedAt: clock.toISOString(),
    });
    expect(actions('device.oob.pin')[1]).toMatchObject({ decision: 'confirmed' });
    const second = await svc.act(OWNER, ep.id, 'check', {});
    expect(second.action.result).toMatchObject({
      pinConfirmed: true,
      authenticated: true,
      systems: ['System.Embedded.1'],
    });
    expect(bmc.requests.filter((r) => r.sentCredentials).map((r) => r.path)).toEqual([
      '/redfish/v1/Systems',
    ]);
    expect((await svc.get(OWNER, ep.id)).lastCheckOk).toBe(true);
    // IPMI has no certificate: nothing to confirm.
    const ipmiEp = await ipmiEndpoint();
    expect((await failure(svc.confirmPin(OWNER, ipmiEp.id, { tlsPin: bmc.pin }))).code).toBe(
      'validation',
    );
    const fresh = await unpinned({ name: 'fresh' });
    expect(
      (await failure(svc.confirmPin(OWNER, fresh.id, { tlsPin: bmc.pin }))).details?.reason,
    ).toBe('no_pin');
  });

  it('refuses a different certificate later, audits it, and sends nothing', async () => {
    const ep = await unpinned();
    await svc.act(OWNER, ep.id, 'check', {});
    await svc.confirmPin(OWNER, ep.id, { tlsPin: bmc.pin });
    const pinned = bmc.pin;
    const seen = bmc.requests.length;
    const presented = bmc.rotateCertificate();
    const err = await failure(svc.act(OWNER, ep.id, 'power.status', {}));
    expect(err.code).toBe('policy_denied');
    expect(err.details).toMatchObject({ reason: 'tls_pin_mismatch', expected: pinned, presented });
    expect(bmc.requests.length).toBe(seen);
    const mismatch = actions('device.oob.pin_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({ decision: 'denied', resource: ep.id });
    expect(mismatch[0]?.detail).toMatchObject({ expected: pinned, presented });
    const [last] = await svc.listActions(OWNER, { endpointId: ep.id, limit: 1 });
    expect(last).toMatchObject({
      action: 'power.status',
      status: 'failed',
      error: { reason: 'tls_pin_mismatch' },
    });
    expect((await svc.get(OWNER, ep.id)).lastError).toContain('different TLS certificate');
    // The owner clears the pin (the BMC certificate was replaced on purpose): read again, and
    // it must be confirmed again before credentials go.
    await svc.update(OWNER, ep.id, { tlsPin: null });
    await svc.act(OWNER, ep.id, 'check', {});
    expect(await svc.get(OWNER, ep.id)).toMatchObject({
      tlsPin: presented,
      tlsPinConfirmed: false,
    });
  });

  it('an entered pin is used from the first connection', async () => {
    const ep = await redfish({ tlsPin: 'ab'.repeat(32) });
    const err = await failure(svc.act(OWNER, ep.id, 'check', {}));
    expect(err.details?.reason).toBe('tls_pin_mismatch');
    expect(bmc.requests).toEqual([]);
    expect(actions('device.oob.pin')).toEqual([]);
  });
});

describe('Redfish actions', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  it('reads power and sensors without an approval', async () => {
    const ep = await redfish();
    const power = await svc.act(OWNER, ep.id, 'power.status', {});
    expect(power.action.result).toEqual({ powerState: 'on' });
    const sensors = await svc.act(OWNER, ep.id, 'sensors', {});
    expect(sensors.action.result).toEqual({
      sensors: [
        { name: 'CPU1 Temp', kind: 'temperature', reading: 47, unit: 'Cel', health: 'ok' },
        { name: 'Inlet Temp', kind: 'temperature', reading: 24, unit: 'Cel', health: 'ok' },
        { name: 'Fan1', kind: 'fan', reading: 5400, unit: 'RPM', health: 'warning' },
        { name: 'PS1 Voltage', kind: 'voltage', reading: 230, unit: 'V', health: 'ok' },
        { name: 'System Power', kind: 'power', reading: 182, unit: 'W', health: 'ok' },
      ],
    });
    expect(posts()).toEqual([]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM approval').get()).toEqual({ n: 0 });
    expect(actions('device.oob.sensors')).toHaveLength(1);
  });

  it('power cycle: a confirm-at-action card first, the BMC only after allow_once', async () => {
    const ep = await redfish();
    const { pending, action } = await svc.act(OWNER, ep.id, 'power.cycle', {});
    expect(pending).toBe(true);
    expect(action.status).toBe('awaiting_approval');
    expect(action.expiresAt).toBe(new Date(clock.getTime() + OOB_APPROVAL_TTL_MS).toISOString());
    expect(bmc.requests).toEqual([]);
    const card = db.raw
      .prepare('SELECT * FROM approval WHERE id = ?')
      .get(action.approvalId) as Record<string, unknown>;
    expect(card).toMatchObject({
      account_id: OWNER,
      tool_name: 'oob.power.cycle',
      tier: 'confirm_at_action',
      answer_in: 'hub',
      risk: 'high',
      status: 'pending',
      options_json: '["allow_once","deny_continue"]',
      scope: `oob:${ep.id}`,
      args_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(String(card.requested_action)).toContain('Power cycle rack-1');
    expect(events.names()).toContain('approval.requested');
    expect(notes[0]).toMatchObject({ kind: 'approval', href: `/approvals/${action.approvalId}` });
    await decide(action.approvalId!, 'allow_once');
    const done = await svc.getAction(OWNER, action.id);
    expect(done).toMatchObject({
      status: 'done',
      before: { powerState: 'on' },
      after: { powerState: 'on' },
      result: { resetType: 'PowerCycle' },
    });
    expect(posts().map((r) => r.body)).toEqual([{ ResetType: 'PowerCycle' }]);
    expect(actions('device.oob.power.cycle').map((a) => a.decision)).toEqual([
      'requested',
      'approved',
      'done',
    ]);
    expect(actions('device.oob.power.cycle')[2]?.detail).toMatchObject({
      before: { powerState: 'on' },
      after: { powerState: 'on' },
    });
    // A second decision event changes nothing.
    await svc.onApprovalDecided(OWNER, action.approvalId!);
    expect(posts()).toHaveLength(1);
  });

  it('a denied, late or mismatched approval never reaches the BMC', async () => {
    const ep = await redfish();
    const off = await svc.act(OWNER, ep.id, 'power.off', {});
    await decide(off.action.approvalId!, 'deny_continue');
    expect((await svc.getAction(OWNER, off.action.id)).status).toBe('denied');
    const reset = await svc.act(OWNER, ep.id, 'power.reset', {});
    clock = new Date(clock.getTime() + OOB_APPROVAL_TTL_MS + 1000);
    await decide(reset.action.approvalId!, 'allow_once');
    expect(await svc.getAction(OWNER, reset.action.id)).toMatchObject({
      status: 'expired',
      error: { reason: 'approval_expired' },
    });
    const on = await svc.act(OWNER, ep.id, 'power.on', {});
    db.raw.prepare("UPDATE approval SET args_hash = 'x' WHERE id = ?").run(on.action.approvalId);
    await decide(on.action.approvalId!, 'allow_once');
    expect((await svc.getAction(OWNER, on.action.id)).error?.reason).toBe('approval_mismatch');
    const timeout = await svc.act(OWNER, ep.id, 'power.on', {});
    await decide(timeout.action.approvalId!, 'timeout');
    expect((await svc.getAction(OWNER, timeout.action.id)).status).toBe('expired');
    // Turned off between the request and the approval: refused at run time.
    const late = await svc.act(OWNER, ep.id, 'power.on', {});
    flags.enabled = false;
    await decide(late.action.approvalId!, 'allow_once');
    expect(await svc.getAction(OWNER, late.action.id)).toMatchObject({
      status: 'failed',
      error: { code: 'oob_disabled' },
    });
    expect(posts()).toEqual([]);
    // Still pending: nothing happens; unknown approvals are ignored.
    flags.enabled = true;
    const waiting = await svc.act(OWNER, ep.id, 'power.on', {});
    await svc.onApprovalDecided(OWNER, waiting.action.approvalId!);
    await svc.onApprovalDecided(OWNER, uuidv7());
    expect((await svc.getAction(OWNER, waiting.action.id)).status).toBe('awaiting_approval');
  });

  it('expired cards are swept and withdrawn; interrupted runs fail at start', async () => {
    const ep = await redfish();
    const a = await svc.act(OWNER, ep.id, 'power.on', {});
    expect(await svc.sweepExpired()).toBe(0);
    clock = new Date(clock.getTime() + OOB_APPROVAL_TTL_MS + 1);
    expect(await svc.sweepExpired()).toBe(1);
    expect((await svc.getAction(OWNER, a.action.id)).status).toBe('expired');
    expect(
      db.raw.prepare('SELECT status FROM approval WHERE id = ?').get(a.action.approvalId),
    ).toEqual({
      status: 'expired',
    });
    expect(events.names()).toContain('approval.cancelled');
    db.raw.prepare("UPDATE oob_action SET status = 'running' WHERE id = ?").run(a.action.id);
    expect(await svc.recover()).toBe(1);
    expect((await svc.getAction(OWNER, a.action.id)).error?.reason).toBe('interrupted');
  });

  it('boot.next sets a one-time override with the ETag', async () => {
    const ep = await redfish();
    const { action } = await svc.act(OWNER, ep.id, 'boot.next', { target: 'pxe', mode: 'uefi' });
    await decide(action.approvalId!, 'allow_once');
    const done = await svc.getAction(OWNER, action.id);
    expect(done).toMatchObject({
      status: 'done',
      before: { enabled: 'Disabled', target: 'None', mode: 'UEFI' },
      after: { enabled: 'Once', target: 'Pxe', mode: 'UEFI' },
    });
    expect(bmc.state.boot).toMatchObject({ enabled: 'Once', target: 'Pxe' });
    // A target the BMC does not offer is refused before any change.
    const usb = await svc.act(OWNER, ep.id, 'boot.next', { target: 'usb' });
    await decide(usb.action.approvalId!, 'allow_once');
    expect((await svc.getAction(OWNER, usb.action.id)).error?.reason).toBe('unsupported_by_bmc');
    expect((await failure(svc.act(OWNER, ep.id, 'boot.next', { target: 'floppy' }))).code).toBe(
      'validation',
    );
  });

  it('a reset type the BMC does not offer is refused', async () => {
    bmc.state.resetAllowed = ['On', 'ForceOff'];
    const ep = await redfish();
    const { action } = await svc.act(OWNER, ep.id, 'power.cycle', {});
    await decide(action.approvalId!, 'allow_once');
    expect(await svc.getAction(OWNER, action.id)).toMatchObject({
      status: 'failed',
      error: { reason: 'unsupported_by_bmc' },
    });
    expect(posts()).toEqual([]);
  });

  it('several systems need a systemId; a redirect is refused', async () => {
    bmc.state.systems = ['A', 'B'];
    const ep = await redfish();
    expect((await failure(svc.act(OWNER, ep.id, 'power.status', {}))).details).toMatchObject({
      reason: 'system_ambiguous',
      systems: ['A', 'B'],
    });
    await svc.update(OWNER, ep.id, { systemId: 'B' });
    expect((await svc.act(OWNER, ep.id, 'power.status', {})).action.status).toBe('done');
    await svc.update(OWNER, ep.id, { systemId: 'C' });
    expect((await failure(svc.act(OWNER, ep.id, 'power.status', {}))).details?.reason).toBe(
      'system_not_found',
    );
    bmc.state.redirectSystems = true;
    expect((await failure(svc.act(OWNER, ep.id, 'check', {}))).details?.reason).toBe(
      'redirect_refused',
    );
    expect((await svc.get(OWNER, ep.id)).lastCheckOk).toBe(false);
  });

  it('wrong credentials and an unreachable BMC fail cleanly', async () => {
    const ep = await redfish({ credentials: { username: 'root', password: 'wrong-pass' } });
    expect((await failure(svc.act(OWNER, ep.id, 'check', {}))).details?.reason).toBe(
      'bmc_auth_failed',
    );
    const port = bmc.port;
    await bmc.close();
    const gone = await redfish({ port, name: 'gone' });
    expect((await failure(svc.act(OWNER, gone.id, 'check', {}))).details?.reason).toBe(
      'bmc_unreachable',
    );
    bmc = await startFakeRedfish();
    const lost = await redfish({ name: 'lost' });
    await secrets.delete(lost.credentialRef);
    expect((await failure(svc.act(OWNER, lost.id, 'power.status', {}))).details?.reason).toBe(
      'credentials_missing',
    );
    // Credentials are read only after the pin and the service root: none were sent.
    expect(bmc.requests.filter((r) => r.sentCredentials)).toEqual([]);
  });
});

describe('Redfish BIOS settings', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  it('reads only allowlisted settings', async () => {
    const ep = await redfish();
    const { action } = await svc.act(OWNER, ep.id, 'bios.read', {});
    const result = action.result as { supported: boolean; settings: { key: string }[] };
    expect(result.supported).toBe(true);
    expect(result.settings.map((s) => s.key)).toEqual([
      'virtualization',
      'secureBoot',
      'tpm',
      'powerOnAfterPowerLoss',
    ]);
    expect(JSON.stringify(action)).not.toContain('SysPassword');
  });

  it('plans need the firmware toggle; the approved plan is applied once to the pending settings', async () => {
    const ep = await redfish();
    const changes = [
      { key: 'virtualization', value: 'Disabled' },
      { key: 'powerOnAfterPowerLoss', value: 'On' },
    ];
    const off = await failure(svc.act(OWNER, ep.id, 'bios.plan', { changes }));
    expect(off.code).toBe('firmware_disabled');
    expect(bmc.requests).toEqual([]);
    flags.firmware = true;
    const { pending, action } = await svc.act(OWNER, ep.id, 'bios.plan', { changes });
    expect(pending).toBe(true);
    const plan = action.result as OobBiosPlanView;
    expect(plan.planId).toBe(action.id);
    expect(plan.diff).toEqual([
      {
        key: 'virtualization',
        vendorKey: 'ProcVirtualization',
        from: 'Enabled',
        to: 'Disabled',
        securityDegrading: false,
      },
      {
        key: 'powerOnAfterPowerLoss',
        vendorKey: 'AcPwrRcvry',
        from: 'Last',
        to: 'On',
        securityDegrading: false,
      },
    ]);
    expect(action.before).toEqual(plan.snapshot.values);
    const card = db.raw
      .prepare('SELECT * FROM approval WHERE id = ?')
      .get(action.approvalId) as Record<string, string>;
    expect(JSON.parse(card.args_preview!)).toMatchObject({ diff: plan.diff });
    expect(card.requested_action).toContain('virtualization Enabled -> Disabled');
    expect(posts()).toEqual([]);
    // Not before its approval.
    const early = await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id }));
    expect(early.code).toBe('approval_required');
    expect(early.details?.approvalId).toBe(action.approvalId);
    await decide(action.approvalId!, 'allow_once');
    expect((await svc.getAction(OWNER, action.id)).status).toBe('approved');
    expect(posts()).toEqual([]);
    const applied = await svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id });
    expect(applied.action).toMatchObject({
      status: 'done',
      planId: action.id,
      before: plan.snapshot.values,
      after: { virtualization: 'Disabled', powerOnAfterPowerLoss: 'On' },
      result: { pendingReboot: true },
    });
    expect(bmc.state.pending).toEqual({ ProcVirtualization: 'Disabled', AcPwrRcvry: 'On' });
    expect(bmc.state.lastApplyTime).toBe('OnReset');
    // The current values are untouched until the reboot.
    expect(bmc.state.attributes.ProcVirtualization).toBe('Enabled');
    expect((await svc.getAction(OWNER, action.id)).status).toBe('applied');
    const again = await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id }));
    expect(again.details?.reason).toBe('plan_used');
    expect(actions('device.oob.bios.apply').at(-1)?.detail).toMatchObject({
      before: plan.snapshot.values,
      after: { virtualization: 'Disabled', powerOnAfterPowerLoss: 'On' },
    });
    expect((await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: uuidv7() }))).code).toBe(
      'not_found',
    );
  });

  it('refuses to apply when the BIOS changed since the plan, or the toggle went off', async () => {
    flags.firmware = true;
    const ep = await redfish();
    const { action } = await svc.act(OWNER, ep.id, 'bios.plan', {
      changes: [{ key: 'virtualization', value: 'Disabled' }],
    });
    await decide(action.approvalId!, 'allow_once');
    bmc.state.attributes.AcPwrRcvry = 'Off';
    const err = await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id }));
    expect(err.details?.reason).toBe('base_mismatch');
    expect(bmc.state.pending).toEqual({});
    // The plan stays approved (nothing was written); with the toggle off it is refused.
    expect((await svc.getAction(OWNER, action.id)).status).toBe('approved');
    flags.firmware = false;
    expect((await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id }))).code).toBe(
      'firmware_disabled',
    );
    flags.firmware = true;
    clock = new Date(clock.getTime() + OOB_APPROVAL_TTL_MS + 1);
    expect(
      (await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id }))).details?.reason,
    ).toBe('plan_expired');
  });

  it('security-degrading changes need the setting and the explicit override', async () => {
    flags.firmware = true;
    const ep = await redfish();
    const ask = {
      changes: [{ key: 'secureBoot', value: 'Disabled' }],
      allowSecurityDegrading: true,
    };
    const refused = await failure(svc.act(OWNER, ep.id, 'bios.plan', ask));
    expect(refused.details).toMatchObject({
      reason: 'nothing_to_change',
      refused: [{ key: 'secureBoot', reason: 'security_degrading' }],
    });
    flags.degrading = true;
    const noOverride = await failure(svc.act(OWNER, ep.id, 'bios.plan', { changes: ask.changes }));
    expect(noOverride.details?.reason).toBe('nothing_to_change');
    const { action } = await svc.act(OWNER, ep.id, 'bios.plan', ask);
    expect((action.result as OobBiosPlanView).allowSecurityDegrading).toBe(true);
    const card = db.raw
      .prepare('SELECT requested_action FROM approval WHERE id = ?')
      .get(action.approvalId) as {
      requested_action: string;
    };
    expect(card.requested_action.startsWith('Weakens security: ')).toBe(true);
    await decide(action.approvalId!, 'allow_once');
    flags.degrading = false;
    const err = await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: action.id }));
    expect(err.details?.reason).toBe('security_degrading');
    expect(bmc.state.pending).toEqual({});
    // The failed plan attempts are on the record.
    const failed = (await svc.listActions(OWNER)).filter(
      (a: OobActionView) => a.status === 'failed',
    );
    expect(failed.map((a) => a.error?.reason)).toEqual(['nothing_to_change', 'nothing_to_change']);
  });

  it('refuses unsupported hardware clearly', async () => {
    flags.firmware = true;
    bmc.state.vendor = 'Supermicro';
    bmc.state.manufacturer = 'Supermicro';
    const ep = await redfish();
    const read = await svc.act(OWNER, ep.id, 'bios.read', {});
    expect(read.action.result).toMatchObject({
      supported: false,
      vendor: 'Supermicro',
      settings: [],
    });
    expect((read.action.result as { reason: string }).reason).toContain('not mapped');
    const err = await failure(
      svc.act(OWNER, ep.id, 'bios.plan', {
        changes: [{ key: 'virtualization', value: 'Disabled' }],
      }),
    );
    expect(err.details?.reason).toBe('unsupported_hardware');
    bmc.state.bios = false;
    expect((await failure(svc.act(OWNER, ep.id, 'bios.read', {}))).details?.reason).toBe(
      'unsupported_hardware',
    );
  });
});

describe('IPMI endpoints', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  it('checks, powers after approval and sets a one-time boot device', async () => {
    const ep = await ipmiEndpoint();
    expect((await svc.act(OWNER, ep.id, 'check', {})).action.result).toEqual({
      protocol: 'ipmi',
      powerState: 'on',
    });
    const off = await svc.act(OWNER, ep.id, 'power.off', {});
    expect(off.pending).toBe(true);
    expect(ipmi.state().lastPower).toBeUndefined();
    await decide(off.action.approvalId!, 'allow_once');
    expect(await svc.getAction(OWNER, off.action.id)).toMatchObject({
      status: 'done',
      before: { powerState: 'on' },
      after: { powerState: 'off' },
    });
    const boot = await svc.act(OWNER, ep.id, 'boot.next', { target: 'pxe', mode: 'uefi' });
    await decide(boot.action.approvalId!, 'allow_once');
    expect(await svc.getAction(OWNER, boot.action.id)).toMatchObject({
      status: 'done',
      before: { bootDevice: 'No override' },
      after: { bootDevice: 'Force PXE' },
      result: { oneTime: true },
    });
    expect(ipmi.state().bootOptions).toEqual(['options=efiboot']);
    expect((await svc.act(OWNER, ep.id, 'sensors', {})).action.status).toBe('done');
    for (const [action, body] of [
      ['bios.read', {}],
      ['bios.plan', { changes: [{ key: 'tpm', value: 'Off' }] }],
      ['boot.next', { target: 'usb' }],
    ] as const) {
      const err = await failure(svc.act(OWNER, ep.id, action, body));
      expect(err.code).toBe('capability_missing');
      expect(err.details?.reason).toBe('not_supported_by_ipmi');
    }
    for (const c of ipmi.state().calls) expect(c.argv).not.toContain('ipmi-secret-7');
  });

  it('a wrong password fails the session', async () => {
    const ep = await ipmiEndpoint({ credentials: { username: 'admin', password: 'nope-nope' } });
    expect((await failure(svc.act(OWNER, ep.id, 'power.status', {}))).details?.reason).toBe(
      'bmc_session_failed',
    );
  });
});

describe('the boot area seam and deleting', () => {
  it('powerCycleFor links the BMC of a device for its owner only while enabled', async () => {
    flags.enabled = true;
    const deviceId = uuidv7();
    const iso = clock.toISOString();
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, created_at, updated_at)
         VALUES (?, ?, 'server', 'client', ?, 'k', '[]', 'active', ?, ?)`,
      )
      .run(deviceId, OWNER, `fp-${deviceId}`, iso, iso);
    expect(await svc.powerCycleFor(OWNER, deviceId)).toBeNull();
    const ep = await redfish({ deviceId });
    expect(await svc.powerCycleFor(OWNER, deviceId)).toEqual({
      endpointId: ep.id,
      endpointName: 'rack-1',
      deviceId,
      action: 'power.cycle',
      method: 'POST',
      href: `/api/v1/oob/endpoints/${ep.id}/actions/power.cycle`,
    });
    expect(await svc.powerCycleFor(MEMBER, deviceId)).toBeNull();
    flags.enabled = false;
    expect(await svc.powerCycleFor(OWNER, deviceId)).toBeNull();
  });

  it('deleting withdraws waiting cards and removes the credentials', async () => {
    flags.enabled = true;
    const ep = await redfish();
    const { action } = await svc.act(OWNER, ep.id, 'power.on', {});
    await svc.remove(OWNER, ep.id);
    expect(await secrets.has(ep.credentialRef)).toBe(false);
    const after = await svc.getAction(OWNER, action.id);
    expect(after).toMatchObject({ status: 'expired', endpointId: null, endpointName: 'rack-1' });
    expect(
      db.raw.prepare('SELECT status FROM approval WHERE id = ?').get(action.approvalId),
    ).toEqual({
      status: 'cancelled',
    });
    await decide(action.approvalId!, 'allow_once');
    expect(posts()).toEqual([]);
    expect(svc.counts()).toEqual({ endpoints: 0, pinned: 0, awaitingApproval: 0 });
    expect(actions('device.oob.endpoint.delete')).toHaveLength(1);
  });
});

describe('turning it on and off, and edges', () => {
  it('setEnabled belongs to the owner and leaves the audit to the settings writer; off withdraws open cards and plans', async () => {
    const write = (v: boolean) => {
      flags.enabled = v;
      return Promise.resolve();
    };
    expect((await failure(svc.setEnabled(MEMBER, true, write))).details?.reason).toBe('owner_only');
    expect(flags.enabled).toBe(false);
    const on = await svc.setEnabled(OWNER, true, write);
    expect(on.enabled).toBe(true);
    // The writer's settings.changed is the change's one audit entry (ADR-096 D3).
    expect(actions('device.oob.enable')).toEqual([]);
    flags.firmware = true;
    const ep = await redfish();
    const waiting = await svc.act(OWNER, ep.id, 'power.on', {});
    const plan = await svc.act(OWNER, ep.id, 'bios.plan', {
      changes: [{ key: 'virtualization', value: 'Disabled' }],
    });
    await decide(plan.action.approvalId!, 'allow_once');
    expect((await svc.getAction(OWNER, plan.action.id)).status).toBe('approved');
    const off = await svc.setEnabled(OWNER, false, write);
    expect(off.enabled).toBe(false);
    expect(actions('device.oob.disable')).toEqual([]);
    for (const id of [waiting.action.id, plan.action.id])
      expect(await svc.getAction(OWNER, id)).toMatchObject({
        status: 'expired',
        error: { reason: 'oob_disabled' },
      });
    expect(
      db.raw.prepare('SELECT status FROM approval WHERE id = ?').get(waiting.action.approvalId),
    ).toEqual({ status: 'cancelled' });
    expect(await svc.withdrawOpen()).toBe(0);
  });

  it('the Hub owner comes from the team tables by default', async () => {
    const plain = new OobService({
      db,
      secrets,
      events,
      log: new Logger({ module: 'oob', sinks: [new MemorySink()] }),
      settings: {
        enabled: () => Promise.resolve(false),
        firmwareAllowChanges: () => Promise.resolve(false),
        firmwareAllowSecurityDegrading: () => Promise.resolve(false),
      },
    });
    expect((await plain.status(OWNER)).enabled).toBe(false);
    expect((await failure(plain.status(MEMBER))).details?.reason).toBe('owner_only');
  });

  it('an AMT row from elsewhere is refused at every step', async () => {
    flags.enabled = true;
    const id = uuidv7();
    const iso = clock.toISOString();
    db.raw
      .prepare(
        `INSERT INTO oob_endpoint (id, account_id, name, kind, address, credential_ref, created_at, updated_at)
         VALUES (?, ?, 'vpro', 'amt', '10.0.0.7', ?, ?, ?)`,
      )
      .run(id, OWNER, oobCredentialRef(id), iso, iso);
    expect((await svc.get(OWNER, id)).supported).toBe(false);
    for (const p of [svc.act(OWNER, id, 'power.status', {}), svc.update(OWNER, id, { name: 'x' })])
      expect((await failure(p)).details?.reason).toBe('not_built');
    await svc.remove(OWNER, id);
  });

  it('sensors through the chassis collection, unreadable credentials, failing sinks', async () => {
    flags.enabled = true;
    bmc.state.linkChassis = false;
    const ep = await redfish();
    const sensors = await svc.act(OWNER, ep.id, 'sensors', {});
    expect((sensors.action.result as { sensors: unknown[] }).sensors).toHaveLength(5);
    await secrets.put(ep.credentialRef, 'not json');
    expect((await failure(svc.act(OWNER, ep.id, 'power.status', {}))).details?.reason).toBe(
      'credentials_missing',
    );
    const ipmiEp = await ipmiEndpoint();
    expect((await failure(svc.update(OWNER, ipmiEp.id, { systemId: 'x' }))).code).toBe(
      'validation',
    );
    // A notifier or audit sink that fails never fails the action.
    const quiet = new OobService({
      db,
      secrets,
      events,
      log: new Logger({ module: 'oob', sinks: [new MemorySink()] }),
      settings: {
        enabled: () => Promise.resolve(true),
        firmwareAllowChanges: () => Promise.resolve(false),
        firmwareAllowSecurityDegrading: () => Promise.resolve(false),
      },
      audit: { append: () => Promise.reject(new Error('audit down')) },
      notifier: { notify: () => Promise.reject(new Error('notify down')) },
      runner: ipmi.runner,
      isOwner: (id) => id === OWNER,
      allowLoopbackForTests: true,
    });
    const asked = await quiet.act(OWNER, ipmiEp.id, 'power.on', {});
    expect(asked.action.status).toBe('awaiting_approval');
    expect((await failure(quiet.getAction(OWNER, uuidv7()))).code).toBe('not_found');
  });

  it('BIOS without a pending settings object or a Bios resource is refused and recorded', async () => {
    flags.enabled = true;
    flags.firmware = true;
    bmc.state.settingsObject = false;
    const ep = await redfish();
    const read = await svc.act(OWNER, ep.id, 'bios.read', {});
    expect(read.action.result).toMatchObject({ supported: true });
    const err = await failure(
      svc.act(OWNER, ep.id, 'bios.plan', {
        changes: [{ key: 'virtualization', value: 'Disabled' }],
      }),
    );
    expect(err.details?.reason).toBe('unsupported_hardware');
    bmc.state.bios = false;
    expect(
      (
        await failure(
          svc.act(OWNER, ep.id, 'bios.plan', {
            changes: [{ key: 'virtualization', value: 'Disabled' }],
          }),
        )
      ).details?.reason,
    ).toBe('unsupported_hardware');
    const failed = (await svc.listActions(OWNER, { endpointId: ep.id })).filter(
      (a) => a.action === 'bios.plan',
    );
    expect(failed.map((a) => a.status)).toEqual(['failed', 'failed']);
    expect(actions('device.oob.bios.plan').map((a) => a.decision)).toEqual(['failed', 'failed']);
  });

  it('an approved plan that is never applied expires with the sweep', async () => {
    flags.enabled = true;
    flags.firmware = true;
    const ep = await redfish();
    const plan = await svc.act(OWNER, ep.id, 'bios.plan', {
      changes: [{ key: 'powerOnAfterPowerLoss', value: 'On' }],
    });
    await decide(plan.action.approvalId!, 'allow_once');
    clock = new Date(clock.getTime() + OOB_APPROVAL_TTL_MS + 1);
    expect(await svc.sweepExpired()).toBe(1);
    expect((await svc.getAction(OWNER, plan.action.id)).status).toBe('expired');
    expect(events.events.filter((e) => e.name === 'approval.cancelled')).toEqual([]);
  });
});

describe('cards withdrawn elsewhere', () => {
  it('a card cancelled at a restart ends its action at the next sweep', async () => {
    flags.enabled = true;
    const ep = await redfish();
    const a = await svc.act(OWNER, ep.id, 'power.cycle', {});
    // What the approvals area does at start (recoverPending).
    db.raw.prepare("UPDATE approval SET status = 'cancelled' WHERE status = 'pending'").run();
    expect(await svc.sweepExpired()).toBe(1);
    expect(await svc.getAction(OWNER, a.action.id)).toMatchObject({
      status: 'expired',
      error: { reason: 'approval_cancelled' },
    });
    expect(bmc.requests).toEqual([]);
  });
});

describe('review fixes: approvals bound to the BMC and to the owner', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  it('an edit withdraws the waiting cards and approved plans of the endpoint', async () => {
    flags.firmware = true;
    const other = await startFakeRedfish();
    try {
      const ep = await redfish();
      const card = await svc.act(OWNER, ep.id, 'power.off', {});
      const plan = await svc.act(OWNER, ep.id, 'bios.plan', {
        changes: [{ key: 'virtualization', value: 'Disabled' }],
      });
      await decide(plan.action.approvalId!, 'allow_once');
      // The endpoint now points at another BMC (its pin entered, so confirmed).
      await svc.update(OWNER, ep.id, { port: other.port, tlsPin: other.pin });
      for (const id of [card.action.id, plan.action.id])
        expect(await svc.getAction(OWNER, id)).toMatchObject({
          status: 'expired',
          error: { reason: 'endpoint_changed' },
        });
      expect(
        db.raw.prepare('SELECT status FROM approval WHERE id = ?').get(card.action.approvalId),
      ).toEqual({ status: 'cancelled' });
      // Answering the withdrawn card, or applying the withdrawn plan, reaches neither BMC.
      await decide(card.action.approvalId!, 'allow_once');
      expect(
        (await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: plan.action.id }))).details
          ?.reason,
      ).toBe('plan_expired');
      expect(posts()).toEqual([]);
      expect(other.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      expect(other.state.pending).toEqual({});
    } finally {
      await other.close();
    }
  });

  it('the approval covers the address, port, system and pin it was asked for', async () => {
    flags.firmware = true;
    const ep = await redfish();
    const card = await svc.act(OWNER, ep.id, 'power.off', {});
    // A change that did not go through update() (another writer) still voids the card.
    db.raw
      .prepare("UPDATE oob_endpoint SET system_id = 'System.Embedded.1' WHERE id = ?")
      .run(ep.id);
    await decide(card.action.approvalId!, 'allow_once');
    expect(await svc.getAction(OWNER, card.action.id)).toMatchObject({
      status: 'failed',
      error: { reason: 'approval_mismatch' },
    });
    db.raw.prepare('UPDATE oob_endpoint SET system_id = NULL WHERE id = ?').run(ep.id);
    const plan = await svc.act(OWNER, ep.id, 'bios.plan', {
      changes: [{ key: 'virtualization', value: 'Disabled' }],
    });
    await decide(plan.action.approvalId!, 'allow_once');
    db.raw.prepare('UPDATE oob_endpoint SET port = ? WHERE id = ?').run(bmc.port, ep.id);
    db.raw.prepare("UPDATE oob_endpoint SET address = 'bmc-x.lab' WHERE id = ?").run(ep.id);
    expect(
      (await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: plan.action.id }))).details
        ?.reason,
    ).toBe('plan_target_changed');
    expect(posts()).toEqual([]);
  });

  it('only the signed-in owner decides: an allow_once recorded by anyone else denies', async () => {
    const ep = await redfish();
    for (const by of ['channel:telegram', 'hook', 'rule', null]) {
      const card = await svc.act(OWNER, ep.id, 'power.cycle', {});
      db.raw
        .prepare(
          "UPDATE approval SET status = 'decided', decision = 'allow_once', decided_by = ?, decided_at = ? WHERE id = ?",
        )
        .run(by, clock.toISOString(), card.action.approvalId);
      await svc.onApprovalDecided(OWNER, card.action.approvalId!);
      expect(await svc.getAction(OWNER, card.action.id)).toMatchObject({
        status: 'denied',
        error: { reason: 'approval_not_by_user' },
      });
    }
    expect(posts()).toEqual([]);
  });
});

describe('review hardening', () => {
  beforeEach(() => {
    flags.enabled = true;
  });

  function strict(over: Partial<ConstructorParameters<typeof OobService>[0]> = {}) {
    return new OobService({
      db,
      secrets,
      events,
      log: new Logger({ module: 'oob', sinks: [new MemorySink()] }),
      settings: {
        enabled: () => Promise.resolve(true),
        firmwareAllowChanges: () => Promise.resolve(false),
        firmwareAllowSecurityDegrading: () => Promise.resolve(false),
      },
      audit: { append: (r) => (audit.push(r), Promise.resolve()) },
      isOwner: (id) => id === OWNER,
      timeoutMs: 2000,
      ...over,
    });
  }

  it('refuses the Hub itself, loopback and names that resolve to them, before connecting', async () => {
    const own = () => ({ addresses: new Set(['10.9.9.9']), names: new Set(['hubhost']) });
    const s1 = strict({ ownAddresses: own });
    for (const address of [
      '10.9.9.9',
      'hubhost',
      '127.0.0.1',
      '::1',
      'localhost',
      '[::ffff:127.0.0.1]:443',
    ]) {
      const err = await failure(
        s1.create(OWNER, { name: 'x', kind: 'redfish', address, credentials: CREDS }),
      );
      expect(err.details?.reason, address).toBe('address_not_allowed');
    }
    // A name is checked again at connect time, every answer of it.
    let lookups = 0;
    const s2 = strict({
      ownAddresses: own,
      resolveHost: (host) => {
        lookups += 1;
        return Promise.resolve(host === 'bmc.lab' ? ['10.1.1.1', '169.254.0.5'] : []);
      },
    });
    const ep = await s2.create(OWNER, {
      name: 'named',
      kind: 'ipmi',
      address: 'bmc.lab',
      credentials: { username: 'admin', password: 'ipmi-secret-7' },
    });
    const err = await failure(s2.act(OWNER, ep.id, 'power.status', {}));
    expect(err.code).toBe('policy_denied');
    expect(err.details).toMatchObject({ reason: 'address_not_allowed', kind: 'link_local' });
    await s2.update(OWNER, ep.id, { address: 'nowhere.lab' });
    expect((await failure(s2.act(OWNER, ep.id, 'check', {}))).details?.reason).toBe(
      'bmc_unreachable',
    );
    expect(lookups).toBe(2);
    expect(ipmi.state().calls).toEqual([]);
  });

  it('a failure after the PATCH fails the plan: it is never applied again as it is', async () => {
    flags.firmware = true;
    const ep = await redfish();
    const plan = await svc.act(OWNER, ep.id, 'bios.plan', {
      changes: [{ key: 'virtualization', value: 'Disabled' }],
    });
    await decide(plan.action.approvalId!, 'allow_once');
    bmc.state.failSettingsReadAfterPatch = true;
    const err = await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: plan.action.id }));
    expect(err.details?.reason).toBe('bmc_error');
    expect(bmc.state.settingsPatches).toBe(1);
    expect(await svc.getAction(OWNER, plan.action.id)).toMatchObject({
      status: 'failed',
      error: { reason: 'apply_outcome_unknown' },
    });
    const again = await failure(svc.act(OWNER, ep.id, 'bios.apply', { planId: plan.action.id }));
    expect(again.details).toMatchObject({ reason: 'plan_failed', cause: 'apply_outcome_unknown' });
    expect(bmc.state.settingsPatches).toBe(1);
  });

  it('card text: BMC values are capped and cleaned; the security warning comes first', async () => {
    flags.firmware = true;
    flags.degrading = true;
    const rlo = String.fromCharCode(0x202e);
    bmc.state.attributes.SecureBoot = `Enabled${String.fromCharCode(7)}${rlo}${'x'.repeat(5000)}`;
    const ep = await redfish({ name: 'rack\u0000-1' });
    const { action } = await svc.act(OWNER, ep.id, 'bios.plan', {
      changes: [{ key: 'secureBoot', value: 'Disabled' }],
      allowSecurityDegrading: true,
    });
    const card = db.raw
      .prepare('SELECT requested_action, args_preview FROM approval WHERE id = ?')
      .get(action.approvalId) as { requested_action: string; args_preview: string };
    expect(card.requested_action.startsWith('Weakens security: ')).toBe(true);
    expect(card.requested_action).toContain('applied at the next reboot');
    expect(card.requested_action.length).toBeLessThan(600);
    expect([...card.requested_action].some((c) => c.charCodeAt(0) < 0x20 || c === rlo)).toBe(false);
    const preview = JSON.parse(card.args_preview) as { diff: { from: string }[] };
    expect(preview.diff[0]?.from.length).toBeLessThanOrEqual(200);
  });

  it('a short BMC password is not made a global redactor literal; a long one is', async () => {
    const { defaultRedactor } = await import('@nova/security');
    const ep = await ipmiEndpoint({ credentials: { username: 'admin', password: 'Ipmi7' } });
    ipmi.set({ password: 'Ipmi7' });
    await svc.act(OWNER, ep.id, 'power.status', {});
    expect(defaultRedactor.redactString('user Ipmi7 here')).toBe('user Ipmi7 here');
    const long = await ipmiEndpoint({
      name: 'long',
      credentials: { username: 'admin', password: 'long-unique-pw-42' },
    });
    ipmi.set({ password: 'long-unique-pw-42' });
    await svc.act(OWNER, long.id, 'power.status', {});
    expect(defaultRedactor.redactString('user long-unique-pw-42 here')).not.toContain(
      'long-unique-pw-42',
    );
  });
});
