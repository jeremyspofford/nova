// Wake Helper routing (FR-138, docs/22 §7) through the devices service: a helper on the target's
// subnet sends the packet over the management channel (a fake transport), the next helper or the
// Hub's own broadcast takes over when one fails, preferred helpers, names that resolve, mesh
// addresses never count, and 409 `no_wake_helper` when nothing reaches the target's LAN — all
// rate-limited, logged in wake_request and audited with `via`.
import type { NetworkInterfaceInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  WAKE_OTHER_PATH,
  WakeHelperRouter,
  deviceHeartbeatSchema,
  deviceReachability,
  managementTokenRef,
  type DeviceTransport,
  type FakeDevice,
  type WolTarget,
} from '../src/index.ts';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';
import { iface } from './network-env.ts';

const MAC = 'aa:bb:cc:dd:ee:ff';

let env: DevicesEnv;
let hubSent: { mac: string; target: WolTarget }[];
let calls: { url: string; token: string; body: unknown }[];
let failing: Set<string>;
let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
let preferred: string[];
let router: WakeHelperRouter;

const transport: DeviceTransport = {
  post(url, token, body) {
    calls.push({ url, token, body });
    if ([...failing].some((f) => url.startsWith(f)))
      return Promise.reject(new Error('connect ECONNREFUSED'));
    return Promise.resolve({ status: 200, body: { ok: true } });
  },
};

function setUrl(device: FakeDevice, url: string): void {
  env.db.raw
    .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
    .run(url, device.deviceId);
}

function setPower(device: FakeDevice, power: unknown): void {
  env.db.raw
    .prepare('UPDATE device_management SET power = ? WHERE device_id = ?')
    .run(typeof power === 'string' ? power : JSON.stringify(power), device.deviceId);
}

async function code(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

beforeEach(async () => {
  hubSent = [];
  calls = [];
  failing = new Set();
  preferred = [];
  interfaces = { eth0: [iface('10.9.0.2', 24)], lo: [iface('127.0.0.1', 8, true)] };
  env = await devicesEnv({
    settings: { wakesPerHour: () => Promise.resolve(20) },
    wol: {
      send: (mac, target) => {
        hubSent.push({ mac, target });
        return Promise.resolve();
      },
    },
  });
  router = new WakeHelperRouter({
    db: env.db,
    secrets: env.secrets,
    transport,
    interfaces: () => interfaces,
    preferred: () => Promise.resolve(preferred),
    lookup: (host) => Promise.resolve(host === 'nas.lan' ? ['192.168.1.20'] : []),
  });
  env.svc.useWakeRouter(router);
});

afterEach(async () => {
  await env.close();
});

function wakeRows(): { helper_device_id: string | null; status: string; error: string | null }[] {
  return env.db.raw
    .prepare('SELECT helper_device_id, status, error FROM wake_request ORDER BY created_at, rowid')
    .all() as { helper_device_id: string | null; status: string; error: string | null }[];
}

describe('wake helpers and device reachability for the network panel', () => {
  it('lists helpers with their addresses and every device with its endpoints', async () => {
    const target = await env.enroll({ wakeMac: MAC });
    const helper = await env.enroll({ roles: ['client', 'wake-helper'] });
    setUrl(helper, 'http://192.168.1.30:7420');
    expect(await router.available(ACCOUNT)).toEqual([
      expect.objectContaining({
        deviceId: helper.deviceId,
        status: 'active',
        addresses: ['192.168.1.30'],
      }),
    ]);
    await env.svc.revoke(ACCOUNT, helper.deviceId!);
    expect(await router.available(ACCOUNT)).toEqual([]);
    const rows = deviceReachability(env.db, ACCOUNT);
    expect(rows).toEqual([
      expect.objectContaining({
        deviceId: target.deviceId,
        status: 'active',
        reachable: true,
        relayPaired: false,
        roles: ['client'],
        endpoints: [
          expect.objectContaining({ transport: 'lan', url: target.endpoint, healthy: true }),
        ],
      }),
    ]);
    expect(deviceReachability(env.db, 'nobody')).toEqual([]);
  });
});

describe('waking through a Wake Helper', () => {
  it('sends through a helper on the target’s subnet and records it as `via`', async () => {
    const target = await env.enroll({ wakeMac: MAC });
    const helper = await env.enroll({ roles: ['client', 'wake-helper'] });
    const far = await env.enroll({ roles: ['wake-helper'] });
    const plain = await env.enroll({ roles: ['client'] });
    setUrl(target, 'http://192.168.1.20:7420');
    setUrl(helper, 'http://192.168.1.30:7420');
    setUrl(far, 'http://10.9.0.5:7420');
    setUrl(plain, 'http://192.168.1.31:7420');
    const w = await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(w).toMatchObject({ status: 'sent', mac: MAC, via: helper.deviceId });
    // The Hub is not on 192.168.1.0/24, so it leaves the broadcast address to the helper.
    expect(calls).toEqual([
      {
        url: `http://192.168.1.30:7420${WAKE_OTHER_PATH}`,
        token: helper.managementToken,
        body: { mac: MAC, port: 9 },
      },
    ]);
    expect(hubSent).toEqual([]);
    expect(wakeRows()).toEqual([
      { helper_device_id: helper.deviceId, status: 'sent', error: null },
    ]);
    const audit = env.audit.filter((a) => a.action === 'device.wake');
    expect(audit.at(-1)?.detail).toMatchObject({ status: 'sent', via: helper.deviceId });
    const event = env.events.events.find((e) => e.name === 'device.wake.sent');
    expect(event?.payload).toMatchObject({ status: 'sent', via: helper.deviceId });
    expect(await router.helpers(ACCOUNT)).toEqual(
      expect.arrayContaining([helper.deviceId, far.deviceId]),
    );
  });

  it('passes the directed broadcast when the Hub knows the subnet, and falls back to the Hub', async () => {
    interfaces = { eth0: [iface('192.168.1.10', 24)] };
    const target = await env.enroll({ wakeMac: MAC });
    const helper = await env.enroll({ roles: ['wake-helper'] });
    setUrl(target, 'http://nas.lan:7420');
    setUrl(helper, 'http://192.168.1.30:7420');
    expect(await router.addresses(target.deviceId!)).toEqual(['192.168.1.20']);
    await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(calls[0]?.body).toEqual({ mac: MAC, port: 9, broadcast: '192.168.1.255' });
    // The helper is down: the Hub broadcasts on that subnet itself.
    failing.add('http://192.168.1.30');
    const w = await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(w.via).toBe('hub');
    expect(hubSent).toEqual([{ mac: MAC, target: { address: '192.168.1.255' } }]);
    expect(wakeRows().map((r) => r.helper_device_id)).toEqual([helper.deviceId, null]);
  });

  it('uses the LAN subnets devices report with their power status', async () => {
    const target = await env.enroll({ wakeMac: MAC });
    const helper = await env.enroll({ roles: ['wake-helper'] });
    setUrl(target, 'http://192.168.7.20:7420');
    // The helper's endpoint is on another network, but it reports the target's LAN as its own.
    setUrl(helper, 'http://10.20.0.5:7420');
    setPower(helper, {
      lan: [
        { interface: 'eth1', network: '192.168.7.0/24', broadcast: '192.168.7.255' },
        { interface: 'tun0', network: '100.64.0.0/10' },
        { interface: 'p2p', network: '10.1.1.0/31' },
        { network: 'nonsense' },
        'junk',
      ],
    });
    await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(calls.at(-1)?.body).toEqual({ mac: MAC, port: 9, broadcast: '192.168.7.255' });
    expect((await router.available(ACCOUNT))[0]?.subnets).toEqual(['192.168.7.0/24']);
    // Both report subnets and the target's endpoint name no longer resolves: same network.
    setUrl(target, 'http://gone.lan:7420');
    setPower(target, { lan: [{ network: '192.168.7.0/24' }] });
    expect(await router.addresses(target.deviceId!)).toEqual([]);
    expect((await env.svc.wake(ACCOUNT, target.deviceId!)).via).toBe(helper.deviceId);
    expect(calls.at(-1)?.body).toMatchObject({ broadcast: '192.168.7.255' });
    // No helper: the Hub on that same network broadcasts with the reported address.
    setPower(helper, 'not json');
    interfaces = { eth0: [iface('192.168.7.2', 24)] };
    const w = await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(w.via).toBe('hub');
    expect(hubSent.at(-1)).toEqual({ mac: MAC, target: { address: '192.168.7.255' } });
  });

  it('tries the next helper, honours the preferred list, and ignores mesh addresses', async () => {
    const target = await env.enroll({ wakeMac: MAC });
    const a = await env.enroll({ roles: ['wake-helper'] });
    const b = await env.enroll({ roles: ['wake-helper'] });
    setUrl(target, 'http://192.168.1.20:7420');
    setUrl(a, 'http://192.168.1.30:7420');
    setUrl(b, 'http://192.168.1.31:7420');
    failing.add('http://192.168.1.30');
    failing.add('http://192.168.1.31');
    // Both fail and the Hub is elsewhere: 409 no_wake_helper, logged and audited, no packet.
    const err = await code(env.svc.wake(ACCOUNT, target.deviceId!));
    expect(err.code).toBe('conflict');
    expect(err.details).toMatchObject({ reason: 'no_wake_helper' });
    expect((err.details?.tried as unknown[]).length).toBe(2);
    expect(wakeRows()).toEqual([
      { helper_device_id: null, status: 'failed', error: 'no_wake_helper' },
    ]);
    expect(env.audit.at(-1)?.detail).toMatchObject({ status: 'failed', via: null });
    expect(hubSent).toEqual([]);
    failing.delete('http://192.168.1.31');
    expect((await env.svc.wake(ACCOUNT, target.deviceId!)).via).toBe(b.deviceId);
    // Only the preferred helpers are used, in their order.
    preferred = [a.deviceId!];
    failing.clear();
    expect((await env.svc.wake(ACCOUNT, target.deviceId!)).via).toBe(a.deviceId);
    preferred = ['someone-else'];
    expect((await code(env.svc.wake(ACCOUNT, target.deviceId!))).details?.reason).toBe(
      'no_wake_helper',
    );
    // Mesh addresses never share a LAN.
    preferred = [];
    setUrl(target, 'http://100.100.1.5:7420');
    setUrl(a, 'http://100.100.1.6:7420');
    setUrl(b, 'http://100.100.1.7:7420');
    expect((await code(env.svc.wake(ACCOUNT, target.deviceId!))).details?.reason).toBe(
      'no_wake_helper',
    );
  });

  it('skips a helper without a management token and keeps the per-hour limit', async () => {
    const target = await env.enroll({ wakeMac: MAC });
    const helper = await env.enroll({ roles: ['wake-helper'] });
    setUrl(target, 'http://192.168.1.20:7420');
    setUrl(helper, 'http://192.168.1.30:7420');
    await env.secrets.delete(managementTokenRef(helper.deviceId!));
    const err = await code(env.svc.wake(ACCOUNT, target.deviceId!));
    expect(err.details?.tried).toEqual([
      { deviceId: helper.deviceId, error: 'no management endpoint' },
    ]);
    // A loopback address says nothing about the target's LAN: no fallback (review finding 18).
    setUrl(target, 'http://127.0.0.1:7420');
    expect((await code(env.svc.wake(ACCOUNT, target.deviceId!))).details?.reason).toBe(
      'no_wake_helper',
    );
    expect(hubSent).toEqual([]);
    // The limit is checked before any routing.
    await env.close();
    env = await devicesEnv({
      settings: { wakesPerHour: () => Promise.resolve(1) },
      wol: { send: () => Promise.resolve() },
    });
    let routed = 0;
    env.svc.useWakeRouter({
      route: () => {
        routed += 1;
        return Promise.resolve({ via: 'hub', address: null });
      },
    });
    const t2 = await env.enroll({ wakeMac: MAC });
    await env.svc.wake(ACCOUNT, t2.deviceId!);
    expect((await code(env.svc.wake(ACCOUNT, t2.deviceId!))).code).toBe('rate_limited');
    expect(routed).toBe(1);
    // A router that fails otherwise is a failed send.
    env.svc.useWakeRouter({ route: () => Promise.reject(new Error('db gone')) });
    await env.close();
    env = await devicesEnv({ wol: { send: () => Promise.resolve() } });
    env.svc.useWakeRouter({ route: () => Promise.reject(new Error('db gone')) });
    const t3 = await env.enroll({ wakeMac: MAC });
    expect((await code(env.svc.wake(ACCOUNT, t3.deviceId!))).code).toBe('server_error');
    env.svc.useWakeRouter(null);
    expect((await env.svc.wake(ACCOUNT, t3.deviceId!)).via).toBe('hub');
  });
});

describe('the default resolver', () => {
  it('resolves names in device endpoints and gives up on dead ones', async () => {
    const plain = new WakeHelperRouter({ db: env.db, secrets: env.secrets });
    const target = await env.enroll({ wakeMac: MAC });
    setUrl(target, 'http://localhost:7420');
    expect(await plain.addresses(target.deviceId!)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(127\.0\.0\.1|::1)$/)]),
    );
    setUrl(target, 'http://nothing.invalid:7420');
    expect(await plain.addresses(target.deviceId!)).toEqual([]);
  });
});

describe('the per-hour wake limit (review finding 13)', () => {
  it('holds under concurrent wakes while a slow helper call is in flight', async () => {
    await env.close();
    env = await devicesEnv({
      settings: { wakesPerHour: () => Promise.resolve(1) },
      wol: { send: () => Promise.resolve() },
    });
    // A slow route, as a Wake Helper call over HTTP can be.
    env.svc.useWakeRouter({
      route: () => new Promise((r) => setTimeout(() => r({ via: 'hub', address: null }), 50)),
    });
    const t = await env.enroll({ wakeMac: MAC });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => env.svc.wake(ACCOUNT, t.deviceId!)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const statuses = (
      env.db.raw.prepare('SELECT status FROM wake_request').all() as { status: string }[]
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 'sent')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'rate_limited')).toHaveLength(7);
  });

  it('counts failed attempts too', async () => {
    await env.close();
    env = await devicesEnv({
      settings: { wakesPerHour: () => Promise.resolve(2) },
      wol: { send: () => Promise.reject(new Error('no route')) },
    });
    const t = await env.enroll({ wakeMac: MAC });
    expect((await code(env.svc.wake(ACCOUNT, t.deviceId!))).code).toBe('server_error');
    env.svc.useWakeRouter({
      route: () =>
        Promise.reject(
          new NovaError('conflict', 'none', { details: { reason: 'no_wake_helper' } }),
        ),
    });
    expect((await code(env.svc.wake(ACCOUNT, t.deviceId!))).code).toBe('conflict');
    expect((await code(env.svc.wake(ACCOUNT, t.deviceId!))).code).toBe('rate_limited');
    const rows = env.db.raw
      .prepare('SELECT status, error FROM wake_request ORDER BY created_at, rowid')
      .all() as { status: string; error: string | null }[];
    expect(rows).toEqual([
      { status: 'failed', error: 'no route' },
      { status: 'failed', error: 'no_wake_helper' },
      { status: 'rate_limited', error: null },
    ]);
  });
});

describe('wake addressing (review findings 17 and 18)', () => {
  it('computes the broadcast address from the reported subnet, never the reported one', async () => {
    interfaces = { eth0: [iface('192.168.1.10', 24)] };
    const target = await env.enroll({ wakeMac: MAC });
    setUrl(target, 'http://192.168.1.20:7420');
    setPower(target, { lan: [{ network: '192.168.1.0/24', broadcast: '203.0.113.7' }] });
    await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(hubSent).toEqual([{ mac: MAC, target: { address: '192.168.1.255' } }]);
    // Through a helper too.
    const helper = await env.enroll({ roles: ['wake-helper'] });
    setUrl(helper, 'http://10.20.0.5:7420');
    setPower(helper, { lan: [{ network: '192.168.7.0/24', broadcast: '198.51.100.1' }] });
    setUrl(target, 'http://192.168.7.20:7420');
    setPower(target, null);
    await env.svc.wake(ACCOUNT, target.deviceId!);
    expect(calls.at(-1)?.body).toEqual({ mac: MAC, port: 9, broadcast: '192.168.7.255' });
  });

  it('never falls back to the Hub broadcasting into a mesh or tunnel interface', async () => {
    interfaces = {
      eth0: [iface('10.9.0.2', 24)],
      wt0: [iface('100.92.0.1', 16)],
      wg0: [iface('10.8.0.1', 24)],
    };
    const target = await env.enroll({ wakeMac: MAC });
    setUrl(target, 'http://100.92.3.4:7420');
    expect((await code(env.svc.wake(ACCOUNT, target.deviceId!))).details?.reason).toBe(
      'no_wake_helper',
    );
    // A plain WireGuard tunnel address outside the mesh ranges either.
    setUrl(target, 'http://10.8.0.5:7420');
    expect((await code(env.svc.wake(ACCOUNT, target.deviceId!))).details?.reason).toBe(
      'no_wake_helper',
    );
    expect(hubSent).toEqual([]);
  });

  it('checks the LAN subnets a heartbeat reports', () => {
    const beat = (lan: unknown) =>
      deviceHeartbeatSchema.safeParse({ novadVersion: '0.6.5', power: { wakeable: true, lan } })
        .success;
    expect(
      beat([{ interface: 'eth0', network: '192.168.1.0/24', broadcast: '192.168.1.255' }]),
    ).toBe(true);
    expect(beat(undefined)).toBe(true);
    for (const bad of [
      [{ network: '192.168.1.7/24' }],
      [{ network: '10.1.1.0/31' }],
      [{ network: '10.0.0.0/0' }],
      [{ network: 'fd00::/64' }],
      [{ network: '192.168.1.0' }],
      [{ network: '192.168.1.0/24/1' }],
      [{ network: 'nonsense' }],
      [{ interface: 'x'.repeat(65), network: '192.168.1.0/24' }],
      'not a list',
      Array.from({ length: 33 }, () => ({ network: '192.168.1.0/24' })),
    ])
      expect(beat(bad)).toBe(false);
  });
});
