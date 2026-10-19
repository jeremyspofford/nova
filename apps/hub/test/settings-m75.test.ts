// The M7.5 consent switches and their audit on a real Hub (ADR-096 D3): turning on
// devices.firmware.allowChanges, devices.firmware.allowSecurityDegrading,
// devices.boot.allowLowLevel or devices.pxe.enabled through PATCH /api/v1/settings needs
// `confirm: true` (403 `policy_denied` `{reason: consent_required}` otherwise) and turning them off
// needs nothing. Every change of these switches, through the settings route, the firmware policy
// route or out-of-band enable/disable, leaves exactly one audit entry: the ops subscriber's
// `setting.changed` with before, after and confirmed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const HOST = { host: '127.0.0.1:7419' };
const CONSENT_KEYS = [
  'devices.firmware.allowChanges',
  'devices.firmware.allowSecurityDegrading',
  'devices.boot.allowLowLevel',
  'devices.pxe.enabled',
] as const;

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let auth: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-settings-m75-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: new MemorySecretStore(),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  auth = {
    ...HOST,
    authorization: `Bearer ${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
  };
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
type Json = Record<string, any>;

async function send(
  method: 'GET' | 'PATCH' | 'PUT' | 'POST',
  url: string,
  payload?: Json,
): Promise<{ status: number; json: Json }> {
  const res = await hub.app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, json: res.json<Json>() };
}

async function value(key: string): Promise<unknown> {
  const all = (await send('GET', '/api/v1/settings')).json.settings as Json[];
  return all.find((s) => s.key === key)?.value;
}

interface Row {
  action: string;
  resource: string | null;
  detail: Json | null;
}

/** The settings and device audit entries, oldest first. */
function rows(): Row[] {
  return (
    db.raw
      .prepare(
        "SELECT action, resource, detail_json FROM audit_event WHERE kind IN ('settings', 'device') ORDER BY seq",
      )
      .all() as { action: string; resource: string | null; detail_json: string | null }[]
  ).map((r) => ({
    action: r.action,
    resource: r.resource,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as Json) : null,
  }));
}

/** Wait for `n` entries, then let any stray one land too, so an exact count means something. */
async function settledRows(n: number): Promise<Row[]> {
  for (let i = 0; i < 200 && rows().length < n; i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return rows();
}

const entry = (key: string, before: boolean, after: boolean, confirmed: boolean): Row => ({
  action: 'setting.changed',
  resource: key,
  detail: { scope: 'global', before, after, confirmed },
});

describe('the settings route consent switches (ADR-096 D3)', () => {
  it.each(CONSENT_KEYS)('%s: on needs confirm, off needs nothing', async (key) => {
    const refused = await send('PATCH', '/api/v1/settings', { key, value: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'consent_required' },
    });
    expect(await value(key)).toBe(false);

    const on = await send('PATCH', '/api/v1/settings', { key, value: true, confirm: true });
    expect(on.status).toBe(200);
    expect(await value(key)).toBe(true);

    const off = await send('PATCH', '/api/v1/settings', { key, value: false });
    expect(off.status).toBe(200);
    expect(await value(key)).toBe(false);

    // One entry per change, with the values and the confirmation; the refusal changed nothing.
    expect(await settledRows(2)).toEqual([
      entry(key, false, true, true),
      entry(key, true, false, false),
    ]);
  });

  it('a switch that widens nothing needs no confirmation', async () => {
    const r = await send('PATCH', '/api/v1/settings', { key: 'routing.allowCloud', value: false });
    expect(r.status).toBe(200);
  });
});

describe('one audit entry per toggle change', () => {
  it('the firmware policy route', async () => {
    const refused = await send('PUT', '/api/v1/devices/firmware/policy', { allowChanges: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.details).toEqual({ reason: 'consent_required' });
    expect(
      (await send('PUT', '/api/v1/devices/firmware/policy', { allowChanges: true, confirm: true }))
        .json,
    ).toEqual({ allowChanges: true, allowSecurityDegrading: false });
    expect(
      (
        await send('PUT', '/api/v1/devices/firmware/policy', {
          allowChanges: true,
          allowSecurityDegrading: true,
          confirm: true,
        })
      ).json,
    ).toEqual({ allowChanges: true, allowSecurityDegrading: true });
    expect(
      (
        await send('PUT', '/api/v1/devices/firmware/policy', {
          allowChanges: false,
          allowSecurityDegrading: false,
        })
      ).json,
    ).toEqual({ allowChanges: false, allowSecurityDegrading: false });
    // An unchanged toggle (allowChanges in the second call) is not written, so not audited.
    expect(await settledRows(4)).toEqual([
      entry('devices.firmware.allowChanges', false, true, true),
      entry('devices.firmware.allowSecurityDegrading', false, true, true),
      entry('devices.firmware.allowChanges', true, false, false),
      entry('devices.firmware.allowSecurityDegrading', true, false, false),
    ]);
    // The audit list carries each entry's detail, so the Diagnostics page can show the change.
    const listed = (await send('GET', '/api/v1/audit?kind=settings')).json.items as Json[];
    expect(listed.map((e) => [e.action, e.resource, e.detail])).toEqual(
      [...rows()].reverse().map((r) => [r.action, r.resource, r.detail]),
    );
  });

  it('out-of-band enable and disable', async () => {
    const refused = await send('PATCH', '/api/v1/settings', {
      key: 'devices.oob.enabled',
      value: true,
      confirm: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error.details).toEqual({ reason: 'consent_required' });
    expect((await send('POST', '/api/v1/oob/enable', { confirm: true })).json.enabled).toBe(true);
    expect(await value('devices.oob.enabled')).toBe(true);
    expect((await send('POST', '/api/v1/oob/disable', {})).json.enabled).toBe(false);
    const all = await settledRows(3);
    // The settings route's refusal is its own entry; each change has exactly one.
    expect(all.filter((r) => r.action === 'device.oob.refuse')).toHaveLength(1);
    expect(all.filter((r) => r.action !== 'device.oob.refuse')).toEqual([
      entry('devices.oob.enabled', false, true, true),
      entry('devices.oob.enabled', true, false, false),
    ]);
  });
});
