// secret-scan: fake-file (the BMC credentials below are made-up fixtures)
// Out-of-band area (FR-147; docs/23 §7; ADR-043, ADR-096 D6) over HTTP: every route needs a
// session and the owner; off by default; the settings route refuses to turn it on (consent
// required) while POST /api/v1/oob/enable {confirm: true} does, audited; a managed lock wins; a
// Redfish BMC (the core fixture: HTTPS on 127.0.0.1, self-signed, pinned on first use) checked,
// power-cycled after its approval card is answered through `approval.decided`, BIOS planned and
// applied with the firmware toggle; an IPMI BMC through a fake ipmitool; turning it off withdraws
// waiting cards; AMT refused; the boot area's seam; the diagnostics probe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  uuidv7,
  type SettingKey,
} from '@nova/shared';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupOob, type OobArea } from '../src/oob.ts';
import {
  startFakeRedfish,
  type FakeBmc,
} from '../../../packages/core/test/fixtures/oob/fake-redfish.ts';
import { fakeIpmi } from '../../../packages/core/test/fixtures/oob/ipmi.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

const OWNER = '01920000-0000-7000-8000-0000000000b1';
const MEMBER = '01920000-0000-7000-8000-0000000000b2';
const AS_OWNER = { 'x-test-account': OWNER };
const AS_MEMBER = { 'x-test-account': MEMBER };

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: OobArea;
let events: EventStore;
let audit: AuditRecord[];
let managed: Record<string, unknown>;
let diagnostics: DiagnosticsRegistry;
let bmc: FakeBmc;
let ipmi: ReturnType<typeof fakeIpmi>;

function globalSettings(): Record<string, unknown> {
  const rows = db.raw
    .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
    .all() as { key: string; value_json: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
}

function putSetting(key: string, value: unknown): void {
  db.raw.prepare("DELETE FROM setting WHERE key = ? AND scope_kind = 'global'").run(key);
  db.raw
    .prepare(
      "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', ?, ?)",
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-oob-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = '2026-10-19T09:00:00.000Z';
  for (const id of [OWNER, MEMBER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  db.raw
    .prepare(
      "INSERT INTO team_member (account_id, role, joined_at) VALUES (?, 'owner', ?), (?, 'member', ?)",
    )
    .run(OWNER, iso, MEMBER, iso);
  managed = {};
  audit = [];
  events = new EventStore(db);
  diagnostics = new DiagnosticsRegistry();
  bmc = await startFakeRedfish();
  ipmi = fakeIpmi(dir);
  const ctx = {
    db,
    secrets: new MemorySecretStore(),
    events,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting: (key: SettingKey) =>
      Promise.resolve(
        resolveSetting(key, { global: globalSettings(), project: {}, managed }).value,
      ),
    accountOf: (req: { headers: Record<string, unknown> }) => {
      const a = req.headers['x-test-account'];
      return a === OWNER || a === MEMBER
        ? Promise.resolve(a)
        : Promise.reject(new NovaError('token_required', 'sign in'));
    },
  } as unknown as HubContext;
  area = await setupOob(ctx, {
    // A stand-in for the Hub's settings writer (app.ts): a managed lock refuses, the value is
    // stored and announced with before, after and confirmed (the ops subscriber audits that).
    writeSetting: async (accountId, key, value, opts) => {
      const layers = { global: globalSettings(), project: {}, managed };
      const before = resolveSetting(key, layers);
      if (before.locked)
        throw new NovaError('policy_denied', `${key} is managed`, {
          details: { reason: 'managed' },
        });
      putSetting(key, value);
      await events.emit({
        name: 'settings.changed',
        actor: 'user',
        accountId,
        payload: { key, scope: 'global', before: before.value, after: value, ...opts },
      });
    },
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    runner: ipmi.runner,
    timeoutMs: 3000,
    allowLoopbackForTests: true,
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', message: err.message } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  // The authentication the Hub puts in front of every route (app.ts), as a stand-in.
  app.decorateRequest('principal', null);
  app.addHook('onRequest', (req, _reply, done) => {
    const a = req.headers['x-test-account'];
    req.principal =
      typeof a === 'string'
        ? { tokenId: 't', kind: 'session', accountId: a, deviceId: null, scopes: null }
        : null;
    done();
  });
  // A stand-in for the lead's settings route (app.ts): store and announce.
  app.patch('/api/v1/settings', async (req) => {
    const body = z.object({ key: z.string(), value: z.unknown() }).parse(req.body);
    putSetting(body.key, body.value);
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: OWNER,
      payload: { key: body.key, scope: 'global' },
    });
    return { ok: true };
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await bmc.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = AS_OWNER,
): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : {}) as Json };
}

const reason = (r: { json: Json }) =>
  (r.json.error as Json | undefined)?.details?.reason as unknown;

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

/** Answer a card the way the approvals gate does: record the decision, then `approval.decided`. */
async function decide(approvalId: string, decision: string): Promise<void> {
  db.raw
    .prepare(
      "UPDATE approval SET status = 'decided', decision = ?, decided_by = 'user', decided_at = ? WHERE id = ?",
    )
    .run(decision, new Date().toISOString(), approvalId);
  await events.emit({
    name: 'approval.decided',
    actor: 'user',
    accountId: OWNER,
    payload: { approvalId, decision, decidedBy: 'user', override: false },
  });
}

async function enable(): Promise<void> {
  const r = await call('POST', '/api/v1/oob/enable', { confirm: true });
  expect(r.status).toBe(200);
}

/** A Redfish endpoint; `pinned` enters the BMC fingerprint (so it is confirmed). */
async function addRedfish(pinned = true): Promise<Json> {
  const r = await call('POST', '/api/v1/oob/endpoints', {
    name: 'rack-1',
    kind: 'redfish',
    address: bmc.host,
    port: bmc.port,
    credentials: { username: 'root', password: 'calvin-secret-9' },
    ...(pinned ? { tlsPin: bmc.pin } : {}),
  });
  expect(r.status).toBe(201);
  return r.json;
}

describe('turning it on', () => {
  it('is off by default and every route needs a session', async () => {
    const status = await call('GET', '/api/v1/oob');
    expect(status.json).toMatchObject({
      enabled: false,
      endpoints: 0,
      kinds: { amt: { built: false } },
    });
    const create = await call('POST', '/api/v1/oob/endpoints', {
      name: 'x',
      kind: 'redfish',
      address: '10.0.0.1',
      credentials: { username: 'a', password: 'b' },
    });
    expect(create.status).toBe(403);
    expect(create.json.error.code).toBe('oob_disabled');
    for (const [method, url] of [
      ['GET', '/api/v1/oob'],
      ['POST', '/api/v1/oob/enable'],
      ['POST', '/api/v1/oob/disable'],
      ['GET', '/api/v1/oob/endpoints'],
      ['POST', '/api/v1/oob/endpoints'],
      ['GET', `/api/v1/oob/endpoints/${uuidv7()}`],
      ['PATCH', `/api/v1/oob/endpoints/${uuidv7()}`],
      ['POST', `/api/v1/oob/endpoints/${uuidv7()}/pin/confirm`],
      ['DELETE', `/api/v1/oob/endpoints/${uuidv7()}`],
      ['POST', `/api/v1/oob/endpoints/${uuidv7()}/actions/power.status`],
      ['GET', '/api/v1/oob/actions'],
      ['GET', `/api/v1/oob/actions/${uuidv7()}`],
    ] as const) {
      const r = await call(method, url, method === 'GET' ? undefined : {}, {});
      expect(r.status, `${method} ${url}`).toBe(401);
    }
  });

  it('the settings route refuses to turn it on; enabling needs {confirm: true} and is audited', async () => {
    const refused = await call('PATCH', '/api/v1/settings', {
      key: 'devices.oob.enabled',
      value: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('policy_denied');
    expect(reason(refused)).toBe('consent_required');
    expect(globalSettings()['devices.oob.enabled']).toBeUndefined();
    expect(audit.find((a) => a.action === 'device.oob.refuse')?.detail).toMatchObject({
      reason: 'consent_required',
      via: 'settings',
    });
    // Other settings and turning it off pass.
    expect(
      (await call('PATCH', '/api/v1/settings', { key: 'devices.oob.enabled', value: false }))
        .status,
    ).toBe(200);
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }, null]) {
      const r = await call('POST', '/api/v1/oob/enable', body ?? undefined);
      expect(r.status).toBe(403);
      expect(reason(r)).toBe('consent_required');
    }
    const on = await call('POST', '/api/v1/oob/enable', { confirm: true });
    expect(on.status).toBe(200);
    expect(on.json.enabled).toBe(true);
    expect(globalSettings()['devices.oob.enabled']).toBe(true);
    const off = await call('POST', '/api/v1/oob/disable', {});
    expect(off.json.enabled).toBe(false);
    // Both go through the settings writer, whose event the ops subscriber audits as the one
    // entry per change (ADR-096 D3); the area appends none of its own.
    const changed = (await events.since(null, 100, { accountId: OWNER, systemEvents: true }))
      .filter((e) => e.name === 'settings.changed' && 'confirmed' in e.payload)
      .map((e) => e.payload);
    expect(changed).toEqual([
      { key: 'devices.oob.enabled', scope: 'global', before: false, after: true, confirmed: true },
      { key: 'devices.oob.enabled', scope: 'global', before: true, after: false, confirmed: false },
    ]);
    expect(audit.filter((a) => a.action !== 'device.oob.refuse')).toEqual([]);
  });

  it('a managed lock wins over the consent', async () => {
    managed['devices.oob.enabled'] = false;
    const r = await call('POST', '/api/v1/oob/enable', { confirm: true });
    expect(r.status).toBe(403);
    expect(reason(r)).toBe('managed');
    expect(globalSettings()['devices.oob.enabled']).toBeUndefined();
  });

  it('a member is refused everything, including enabling', async () => {
    await enable();
    const ep = await addRedfish();
    for (const [method, url, body] of [
      ['POST', '/api/v1/oob/enable', { confirm: true }],
      ['POST', '/api/v1/oob/disable', {}],
      ['GET', '/api/v1/oob', undefined],
      ['GET', '/api/v1/oob/endpoints', undefined],
      ['GET', `/api/v1/oob/endpoints/${ep.id}`, undefined],
      ['POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.status`, {}],
      ['POST', `/api/v1/oob/endpoints/${ep.id}/pin/confirm`, { tlsPin: bmc.pin }],
      ['DELETE', `/api/v1/oob/endpoints/${ep.id}`, undefined],
    ] as const) {
      const r = await call(method, url, body, AS_MEMBER);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(reason(r)).toBe('owner_only');
    }
    expect(bmc.requests).toEqual([]);
    expect(await area.powerCycleFor(MEMBER, uuidv7())).toBeNull();
  });
});

describe('endpoints and actions over HTTP', () => {
  beforeEach(enable);

  it('checks a Redfish BMC, confirms its fingerprint, then power cycles it after approval', async () => {
    const ep = await addRedfish(false);
    expect(JSON.stringify(ep)).not.toContain('calvin-secret-9');
    const check = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/check`, {});
    expect(check.status).toBe(200);
    expect(check.json.action).toMatchObject({
      status: 'done',
      result: { vendor: 'Dell', tlsPin: bmc.pin, pinConfirmed: false, authenticated: false },
    });
    expect(bmc.requests.some((r) => r.sentCredentials)).toBe(false);
    const early = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.cycle`, {});
    expect(early.status).toBe(409);
    expect(reason(early)).toBe('pin_unconfirmed');
    const wrong = await call('POST', `/api/v1/oob/endpoints/${ep.id}/pin/confirm`, {
      tlsPin: 'ab'.repeat(32),
    });
    expect(reason(wrong)).toBe('pin_changed');
    const confirmed = await call('POST', `/api/v1/oob/endpoints/${ep.id}/pin/confirm`, {
      tlsPin: bmc.pin,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ tlsPin: bmc.pin, tlsPinConfirmed: true });
    const authed = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/check`, {});
    expect(authed.json.action.result).toMatchObject({ authenticated: true });
    const asked = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.cycle`, {});
    expect(asked.status).toBe(202);
    const action = asked.json.action as Json;
    expect(action.status).toBe('awaiting_approval');
    expect(bmc.requests.filter((r) => r.method === 'POST')).toEqual([]);
    await decide(action.approvalId as string, 'allow_once');
    const done = await until(
      () => call('GET', `/api/v1/oob/actions/${action.id as string}`),
      (r) => r.json.status === 'done' || r.json.status === 'failed',
    );
    expect(done.json).toMatchObject({ status: 'done', result: { resetType: 'PowerCycle' } });
    expect(bmc.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
      { ResetType: 'PowerCycle' },
    ]);
    const list = await call('GET', `/api/v1/oob/actions?endpointId=${ep.id as string}&limit=10`);
    expect((list.json.items as Json[]).map((a) => a.action)).toEqual([
      'power.cycle',
      'check',
      'check',
    ]);
    expect(
      audit.filter((a) => a.action === 'device.oob.power.cycle').map((a) => a.decision),
    ).toEqual(['requested', 'approved', 'done']);
    // A different certificate later: refused, audited.
    bmc.rotateCertificate();
    const mismatch = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.status`, {});
    expect(mismatch.status).toBe(403);
    expect(reason(mismatch)).toBe('tls_pin_mismatch');
    expect(audit.some((a) => a.action === 'device.oob.pin_mismatch')).toBe(true);
  });

  it('a denied card never reaches the BMC', async () => {
    const ep = await addRedfish();
    const asked = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.off`, {});
    await decide(asked.json.action.approvalId as string, 'deny_continue');
    const r = await until(
      () => call('GET', `/api/v1/oob/actions/${asked.json.action.id as string}`),
      (x) => x.json.status !== 'awaiting_approval',
    );
    expect(r.json.status).toBe('denied');
    expect(bmc.requests).toEqual([]);
  });

  it('BIOS: the plan follows the firmware toggle, its card carries the diff, then it applies once', async () => {
    const ep = await addRedfish();
    const url = `/api/v1/oob/endpoints/${ep.id}/actions`;
    const changes = [{ key: 'virtualization', value: 'Disabled' }];
    const off = await call('POST', `${url}/bios.plan`, { changes });
    expect(off.status).toBe(403);
    expect(off.json.error.code).toBe('firmware_disabled');
    putSetting('devices.firmware.allowChanges', true);
    const plan = await call('POST', `${url}/bios.plan`, { changes });
    expect(plan.status).toBe(202);
    expect(plan.json.action.result.diff).toEqual([
      {
        key: 'virtualization',
        vendorKey: 'ProcVirtualization',
        from: 'Enabled',
        to: 'Disabled',
        securityDegrading: false,
      },
    ]);
    const early = await call('POST', `${url}/bios.apply`, { planId: plan.json.action.id });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('approval_required');
    await decide(plan.json.action.approvalId as string, 'allow_once');
    await until(
      () => call('GET', `/api/v1/oob/actions/${plan.json.action.id as string}`),
      (r) => r.json.status === 'approved',
    );
    const applied = await call('POST', `${url}/bios.apply`, { planId: plan.json.action.id });
    expect(applied.status).toBe(200);
    expect(applied.json.action).toMatchObject({
      status: 'done',
      after: { virtualization: 'Disabled' },
    });
    expect(bmc.state.pending).toEqual({ ProcVirtualization: 'Disabled' });
    const twice = await call('POST', `${url}/bios.apply`, { planId: plan.json.action.id });
    expect(reason(twice)).toBe('plan_used');
  });

  it('IPMI through ipmitool; AMT refused; bad input refused', async () => {
    const ep = await call('POST', '/api/v1/oob/endpoints', {
      name: 'old-box',
      kind: 'ipmi',
      address: '127.0.0.1',
      credentials: { username: 'admin', password: 'ipmi-secret-7' },
    });
    const status = await call(
      'POST',
      `/api/v1/oob/endpoints/${ep.json.id as string}/actions/power.status`,
      {},
    );
    expect(status.json.action.result).toEqual({ powerState: 'on' });
    const amt = await call('POST', '/api/v1/oob/endpoints', {
      name: 'vpro',
      kind: 'amt',
      address: '10.0.0.7',
      credentials: { username: 'admin', password: 'x' },
    });
    expect(amt.status).toBe(400);
    expect(amt.json.error.code).toBe('capability_missing');
    expect(reason(amt)).toBe('not_built');
    const unknown = await call(
      'POST',
      `/api/v1/oob/endpoints/${ep.json.id as string}/actions/console`,
      {},
    );
    expect(unknown.status).toBe(400);
    const extra = await call(
      'POST',
      `/api/v1/oob/endpoints/${ep.json.id as string}/actions/power.on`,
      {
        force: true,
      },
    );
    expect(extra.status).toBe(400);
    const bad = await call('POST', '/api/v1/oob/endpoints', {
      name: 'x',
      kind: 'redfish',
      address: 'https://root:pw@10.0.0.1',
      credentials: { username: 'a', password: 'b' },
    });
    expect(bad.status).toBe(400);
    expect(reason(bad)).toBe('credentials_in_address');
    const renamed = await call('PATCH', `/api/v1/oob/endpoints/${ep.json.id as string}`, {
      name: 'older-box',
    });
    expect(renamed.json.name).toBe('older-box');
    const del = await call('DELETE', `/api/v1/oob/endpoints/${ep.json.id as string}`);
    expect(del.json).toEqual({ ok: true });
    expect((await call('GET', '/api/v1/oob/endpoints')).json.items).toEqual([]);
  });

  it('turning it off withdraws waiting cards, by its route or the settings route', async () => {
    const ep = await addRedfish();
    const a = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.on`, {});
    await call('POST', '/api/v1/oob/disable', {});
    const after = await call('GET', `/api/v1/oob/actions/${a.json.action.id as string}`);
    expect(after.json).toMatchObject({ status: 'expired', error: { reason: 'oob_disabled' } });
    expect(
      db.raw.prepare('SELECT status FROM approval WHERE id = ?').get(a.json.action.approvalId),
    ).toEqual({
      status: 'cancelled',
    });
    await enable();
    const b = await call('POST', `/api/v1/oob/endpoints/${ep.id}/actions/power.on`, {});
    await call('PATCH', '/api/v1/settings', { key: 'devices.oob.enabled', value: false });
    const withdrawn = await until(
      () => call('GET', `/api/v1/oob/actions/${b.json.action.id as string}`),
      (r) => r.json.status === 'expired',
    );
    expect(withdrawn.json.error.reason).toBe('oob_disabled');
    // A card answered after that does nothing.
    await decide(b.json.action.approvalId as string, 'allow_once');
    expect(bmc.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('offers the boot area a power cycle for a linked device and reports diagnostics', async () => {
    const deviceId = uuidv7();
    const iso = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, created_at, updated_at)
         VALUES (?, ?, 'server', 'client', ?, 'k', '[]', 'active', ?, ?)`,
      )
      .run(deviceId, OWNER, `fp-${deviceId}`, iso, iso);
    expect(await area.powerCycleFor(OWNER, deviceId)).toBeNull();
    const ep = await addRedfish();
    await call('PATCH', `/api/v1/oob/endpoints/${ep.id}`, { deviceId });
    expect(await area.powerCycleFor(OWNER, deviceId)).toMatchObject({
      endpointId: ep.id,
      action: 'power.cycle',
      href: `/api/v1/oob/endpoints/${ep.id}/actions/power.cycle`,
    });
    const diag = await diagnostics.collect();
    expect(diag.oob).toEqual({ enabled: true, endpoints: 1, pinned: 1, awaitingApproval: 0 });
  });
});
