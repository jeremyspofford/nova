// The wake route through a Wake Helper (FR-138, docs/22 §7): POST /api/v1/devices/:id/wake with
// the devices area wired to the network area's router. A helper on the target's subnet sends it
// over the management channel (a fake transport), the Hub broadcasts when it is on that subnet,
// else 409 `no_wake_helper`; the per-hour limit stays; audited with `via`; the panel lists helpers.
import type { NetworkInterfaceInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeDevice,
  WAKE_OTHER_PATH,
  type AuditRecord,
  type DeviceTransport,
  type WolTarget,
} from '@nova/core';
import { setupDevices, type DevicesArea } from '../src/devices.ts';
import { iface, networkEnv, type NetworkEnv } from './network-env.ts';

const MAC = '0a:0b:0c:0d:0e:0f';

let env: NetworkEnv;
let devices: DevicesArea;
let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
let calls: { url: string; token: string; body: unknown }[];
let hubSent: { mac: string; target: WolTarget }[];
let deviceAudit: AuditRecord[];
let fakes: FakeDevice[];

const transport: DeviceTransport = {
  post(url, token, body) {
    calls.push({ url, token, body });
    return Promise.resolve({ status: 200, body: { ok: true } });
  },
};

async function start(settings: Record<string, unknown> = {}): Promise<void> {
  env = await networkEnv({
    settings,
    interfaces: () => interfaces,
    deps: { transport },
    extra: async (ctx, app) => {
      devices = await setupDevices(ctx, {
        wol: {
          send: (mac, target) => {
            hubSent.push({ mac, target });
            return Promise.resolve();
          },
        },
      });
      devices.register(app);
      return devices;
    },
  });
  devices.useAudit({ append: (r) => (deviceAudit.push(r), Promise.resolve()) });
  // The wiring the lead adds in app.ts.
  devices.service.useWakeRouter(env.area.wakeRouter);
}

async function enroll(
  roles: string[],
  url: string,
  wakeMac: string | null = null,
): Promise<FakeDevice> {
  const t = await env.api('POST', '/api/v1/devices/novad/enroll', { roles });
  expect(t.status).toBe(201);
  const fake = new FakeDevice({ roles, wakeMac });
  fakes.push(fake);
  await fake.enroll(env.url, t.json.token as string);
  env.db.raw
    .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
    .run(url, fake.deviceId);
  return fake;
}

beforeEach(() => {
  interfaces = { eth0: [iface('10.9.0.2', 24)] };
  calls = [];
  hubSent = [];
  deviceAudit = [];
  fakes = [];
});

afterEach(async () => {
  for (const f of fakes) await f.close();
  await env.close();
});

describe('POST /api/v1/devices/:id/wake with Wake Helpers', () => {
  it('sends through a helper on the target’s LAN and audits `via`', async () => {
    await start();
    const target = await enroll(['client'], 'http://192.168.7.20:7420', MAC);
    const helper = await enroll(['client', 'wake-helper'], 'http://192.168.7.30:7420');
    const w = await env.api('POST', `/api/v1/devices/${target.deviceId!}/wake`);
    expect(w.status).toBe(200);
    expect(w.json).toMatchObject({ status: 'sent', mac: MAC, via: helper.deviceId });
    expect(calls).toEqual([
      {
        url: `http://192.168.7.30:7420${WAKE_OTHER_PATH}`,
        token: helper.managementToken,
        body: { mac: MAC, port: 9 },
      },
    ]);
    expect(hubSent).toEqual([]);
    expect(deviceAudit.find((a) => a.action === 'device.wake')?.detail).toMatchObject({
      via: helper.deviceId,
      status: 'sent',
    });
    // The panel lists the helper with its address; it can be made the preferred one.
    const view = (await env.api('GET', '/api/v1/network')).json;
    expect(view.wakeHelpers.recent).toMatchObject([
      { deviceId: target.deviceId, status: 'sent', via: helper.deviceId },
    ]);
    expect(view.wakeHelpers.recent[0].viaName).toBeTruthy();
    expect(view.wakeHelpers.available).toEqual([
      expect.objectContaining({ deviceId: helper.deviceId, addresses: ['192.168.7.30'] }),
    ]);
    const p = await env.api('PATCH', '/api/v1/network', { wakeHelpers: [helper.deviceId] });
    expect(p.json.wakeHelpers.configured).toEqual([helper.deviceId]);
  });

  it('falls back to the Hub on its own subnet, else refuses with no_wake_helper', async () => {
    await start();
    const target = await enroll(['client'], 'http://192.168.7.20:7420', MAC);
    const no = await env.api('POST', `/api/v1/devices/${target.deviceId!}/wake`);
    expect(no.status).toBe(409);
    expect(no.json.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'no_wake_helper' },
    });
    expect(deviceAudit.at(-1)).toMatchObject({ action: 'device.wake', detail: { via: null } });
    interfaces = { eth0: [iface('192.168.7.10', 24)] };
    const w = await env.api('POST', `/api/v1/devices/${target.deviceId!}/wake`);
    expect(w.json).toMatchObject({ status: 'sent', via: 'hub' });
    expect(hubSent).toEqual([{ mac: MAC, target: { address: '192.168.7.255' } }]);
    // The panel lists both attempts, newest first: sent by the Hub, then refused with no helper.
    const view = (await env.api('GET', '/api/v1/network')).json;
    expect(view.wakeHelpers.recent).toMatchObject([
      { deviceId: target.deviceId, mac: MAC, status: 'sent', via: 'hub', viaName: null },
      { deviceId: target.deviceId, status: 'failed', via: null },
    ]);
  });

  it('keeps the per-hour limit', async () => {
    await start({ 'devices.wakesPerHour': 1 });
    interfaces = { eth0: [iface('192.168.7.10', 24)] };
    const target = await enroll(['client'], 'http://192.168.7.20:7420', MAC);
    expect((await env.api('POST', `/api/v1/devices/${target.deviceId!}/wake`)).status).toBe(200);
    const limited = await env.api('POST', `/api/v1/devices/${target.deviceId!}/wake`);
    expect(limited.status).toBe(429);
    expect(hubSent).toHaveLength(1);
  });
});
