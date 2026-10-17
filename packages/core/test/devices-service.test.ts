// DeviceService against a fake novad (FR-141, FR-142, FR-144, FR-145, FR-148, FR-150): one-use
// enrollment with a signed capability document and a pinned key, heartbeats with module crash
// reports, the sweep, re-signed capability updates, overrides and policy pushed to the device,
// version gating, module and service actions, power and Wake-on-LAN with rate limits, signed
// updates in order with rollback, and revocation.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import { NodeService, canonicalJson, managementTokenRef, type FakeDevice } from '../src/index.ts';
import { ACCOUNT, OTHER, devicesEnv, type DevicesEnv } from './devices-env.ts';

let env: DevicesEnv;
let woken: string[];

beforeEach(async () => {
  woken = [];
  env = await devicesEnv({
    wol: {
      send: (mac) => {
        woken.push(mac);
        return Promise.resolve();
      },
    },
  });
});

afterEach(async () => {
  await env.close();
});

async function rejects(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

describe('enrollment', () => {
  it('registers a device with a one-use token and a signed document', async () => {
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client', 'compute'], 'http://hub:7419');
    expect(t.token).toMatch(/^nvd_/);
    expect(t.command).toContain('novad enroll --hub http://hub:7419');
    expect(t.command).toContain('--role compute');
    const { FakeDevice } = await import('../src/index.ts');
    const fake = new FakeDevice({
      name: 'desk',
      roles: ['client', 'compute'],
      modules: ['management', 'storage', 'compute'],
    });
    env.devices.push(fake);
    const r = await fake.enroll(env.hubUrl, t.token);
    expect(r.credential).toMatch(/^nvc_/);
    expect(await env.secrets.get(managementTokenRef(fake.deviceId!))).toBe(fake.managementToken);
    const [view] = await env.svc.list(ACCOUNT);
    expect(view).toMatchObject({
      id: fake.deviceId,
      name: 'desk',
      roles: ['client', 'compute'],
      status: 'active',
      novadVersion: '0.6.0',
      updateChannel: 'stable',
      updateRequired: false,
      routingEligible: true,
    });
    expect(env.events.names()).toContain('device.registered');
    expect(env.audit.map((a) => a.action)).toContain('device.register');
    // The same token again: refused.
    const again = new (await import('../src/index.ts')).FakeDevice();
    env.devices.push(again);
    await expect(again.enroll(env.hubUrl, t.token)).rejects.toThrow(/401/);
    // Another account sees nothing.
    expect(await env.svc.list(OTHER)).toEqual([]);
    // A novad device is not a compute node, even with the compute role.
    const nodes = new NodeService({ db: env.db, secrets: env.secrets, events: env.events });
    expect(await nodes.list(ACCOUNT)).toEqual([]);
  });

  it('burns the token when the signature does not verify', async () => {
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client'], 'http://hub');
    const { FakeDevice } = await import('../src/index.ts');
    const fake = new FakeDevice();
    env.devices.push(fake);
    await fake.listen();
    const capability = fake.capability();
    const err = await rejects(
      env.svc.register({
        enrollToken: t.token,
        name: 'x',
        endpoint: fake.endpoint,
        publicKey: fake.publicKey,
        capability,
        signature: fake.sign({ ...capability, name: 'tampered' }),
        managementToken: fake.managementToken,
        novadVersion: '0.6.0',
        protocolVersions: [1],
      }),
    );
    expect(err.details).toMatchObject({ reason: 'bad_signature' });
    await expect(fake.enroll(env.hubUrl, t.token)).rejects.toThrow(/401/);
  });

  it('refuses compute-node tokens, bad protocols and unknown credentials', async () => {
    const nodes = new NodeService({ db: env.db, secrets: env.secrets, events: env.events });
    const nodeToken = await nodes.createEnrollToken(ACCOUNT);
    const { FakeDevice } = await import('../src/index.ts');
    const fake = new FakeDevice();
    env.devices.push(fake);
    await expect(fake.enroll(env.hubUrl, nodeToken.token)).rejects.toThrow(/401/);
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client'], 'http://hub');
    const capability = fake.capability();
    const err = await rejects(
      env.svc.register({
        enrollToken: t.token,
        name: 'x',
        endpoint: fake.endpoint,
        publicKey: fake.publicKey,
        capability,
        signature: fake.sign(capability),
        managementToken: fake.managementToken,
        novadVersion: '0.6.0',
        protocolVersions: [99],
      }),
    );
    expect(err.code).toBe('capability_missing');
    expect(await env.svc.authenticate('nvc_nope')).toBeNull();
    expect(await env.svc.authenticate('nvn_compute')).toBeNull();
    await expect(env.svc.heartbeat('nvc_nope', {})).rejects.toThrow(/not valid/);
  });
});

describe('heartbeats and capabilities', () => {
  it('reports module crashes and marks a silent device unreachable', async () => {
    const fake = await env.enroll({ modules: ['management', 'storage'] });
    fake.crashModule('storage');
    const hb = await fake.heartbeat();
    expect(hb.status).toBe(200);
    const changes = env.events.events.filter((e) => e.name === 'device.module.changed');
    expect(changes.map((e) => e.payload.kind)).toEqual(['crashed', 'restarted']);
    expect(changes[0]!.payload).toMatchObject({ module: 'storage', exit: 'killed by signal 9' });
    fake.crashModule('storage', true);
    await fake.heartbeat();
    const view = await env.svc.get(ACCOUNT, fake.deviceId!);
    expect(view.modules.find((m) => m.name === 'storage')).toMatchObject({
      state: 'disabled',
      disabledReason: 'crash_loop',
      restarts: 2,
    });
    expect(env.audit.map((a) => a.action)).toContain('device.module.disabled');
    // Three missed beats.
    env.clock.now += 31_000;
    expect(await env.svc.sweep()).toEqual([fake.deviceId]);
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).status).toBe('unreachable');
    await expect(
      env.svc.listFiles(ACCOUNT, fake.deviceId!, { kind: 'user', id: ACCOUNT }, '/'),
    ).rejects.toThrow(/not reachable/);
    await fake.heartbeat();
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).status).toBe('active');
    const status = env.events.events
      .filter((e) => e.name === 'device.status.changed')
      .map((e) => e.payload.status);
    expect(status).toEqual(['unreachable', 'active']);
  });

  it('takes re-signed documents only from the pinned key', async () => {
    const fake = await env.enroll();
    fake.roles = ['client', 'wake-helper'];
    expect(await fake.sendCapabilities()).toBe(200);
    const view = await env.svc.get(ACCOUNT, fake.deviceId!);
    expect(view.capability?.roles).toEqual(['client', 'wake-helper']);
    const { privateKey } = generateKeyPairSync('ed25519');
    const doc = fake.capability();
    const other = sign(null, Buffer.from(canonicalJson(doc)), privateKey).toString('base64url');
    const err = await rejects(
      env.svc.updateCapabilities(fake.credential!, {
        capability: doc,
        signature: other,
        novadVersion: '0.6.0',
      }),
    );
    expect(err.details).toMatchObject({ reason: 'bad_signature' });
    const moved = { ...doc, deviceId: 'someone-else' };
    const err2 = await rejects(
      env.svc.updateCapabilities(fake.credential!, {
        capability: moved,
        signature: fake.sign(moved),
        novadVersion: '0.6.0',
      }),
    );
    expect(err2.details).toMatchObject({ reason: 'device_mismatch' });
    const invalid = { ...doc, schemaVersion: 2 };
    const err3 = await rejects(
      env.svc.updateCapabilities(fake.credential!, {
        capability: invalid,
        signature: fake.sign(invalid),
        novadVersion: '0.6.0',
      }),
    );
    expect(err3.details).toMatchObject({ reason: 'invalid_capability' });
  });

  it('gates capabilities by the novad version (FR-148)', async () => {
    const old = await env.enroll({ novadVersion: '0.0.0' });
    const view = await env.svc.get(ACCOUNT, old.deviceId!);
    expect(view.updateRequired).toBe(true);
    expect(view.capabilities.find((c) => c.name === 'files')?.reason).toBe('update_required');
    const err = await rejects(
      env.svc.listFiles(ACCOUNT, old.deviceId!, { kind: 'user', id: ACCOUNT }, '/'),
    );
    expect(err.code).toBe('capability_missing');
    expect(err.details).toMatchObject({ reason: 'update_required', minVersion: '0.6.0' });
    // The device updates: the next heartbeat carries the new version and capabilities return.
    old.novadVersion = '0.6.1';
    const hb = await old.heartbeat();
    expect(hb.json.capabilityRequested).toBe(true);
    expect((await env.svc.get(ACCOUNT, old.deviceId!)).updateRequired).toBe(false);
  });

  it('raises minimums from the setting', async () => {
    await env.close();
    env = await devicesEnv({
      settings: { minVersions: () => Promise.resolve({ files: '0.7.0' }) },
    });
    const fake = await env.enroll();
    const view = await env.svc.get(ACCOUNT, fake.deviceId!);
    expect(view.capabilities.find((c) => c.name === 'files')).toMatchObject({
      available: false,
      minVersion: '0.7.0',
    });
    expect(view.capabilities.find((c) => c.name === 'exec')?.available).toBe(true);
  });
});

describe('overrides and policy (FR-142, FR-150)', () => {
  it('pushes overrides, stores the re-signed document and applies policy', async () => {
    const fake = await env.enroll({ modules: ['management', 'storage', 'compute'] });
    const view = await env.svc.update(ACCOUNT, fake.deviceId!, {
      capabilityOverrides: {
        scheduling: { routingWeight: 7, quietHours: ['22:00-07:00'] },
        computePolicy: { vramReserveBytes: 2048 },
      },
      policy: {
        allowedModules: ['management', 'storage'],
        routingEligible: false,
        quietHours: ['22:00-07:00'],
      },
      updateChannel: 'beta',
      name: 'study',
    });
    expect(view.name).toBe('study');
    expect(view.configPending).toBe(false);
    expect(view.capability?.scheduling).toMatchObject({ routingWeight: 7 });
    expect(view.updateChannel).toBe('beta');
    expect(view.routingEligible).toBe(false);
    expect(fake.hubConfig.policy).toMatchObject({ allowedModules: ['management', 'storage'] });
    expect(fake.modules.get('compute')?.state).toBe('stopped');
    expect(
      env.events.events.find((e) => e.name === 'device.overrides.changed')?.payload,
    ).toMatchObject({ pushed: true });
    // The Hub refuses to start a module its policy does not allow.
    const err = await rejects(env.svc.moduleAction(ACCOUNT, fake.deviceId!, 'compute', 'start'));
    expect(err.details).toMatchObject({ reason: 'module_not_allowed' });
    // Quiet hours, in the device's time zone (UTC here).
    env.clock.now = Date.parse('2026-10-17T23:00:00.000Z');
    expect(await env.svc.quiet(ACCOUNT, fake.deviceId!)).toBe(true);
    env.clock.now = Date.parse('2026-10-17T12:00:00.000Z');
    expect(await env.svc.quiet(ACCOUNT, fake.deviceId!)).toBe(false);
  });

  it('keeps changes pending while the device is away and pushes them on its next beat', async () => {
    const fake = await env.enroll();
    await fake.close();
    const view = await env.svc.update(ACCOUNT, fake.deviceId!, {
      capabilityOverrides: { limits: { maxEgressMbps: 50 } },
    });
    expect(view.configPending).toBe(true);
    await fake.listen();
    // The endpoint moved (a new port): re-point it as a re-registration would.
    env.db.raw
      .prepare('UPDATE transport_endpoint SET url = ? WHERE device_id = ?')
      .run(fake.endpoint, fake.deviceId);
    await fake.heartbeat();
    for (let i = 0; i < 50 && (await env.svc.get(ACCOUNT, fake.deviceId!)).configPending; i++)
      await new Promise((r) => setTimeout(r, 10));
    const after = await env.svc.get(ACCOUNT, fake.deviceId!);
    expect(after.configPending).toBe(false);
    expect(after.capability?.limits).toMatchObject({ maxEgressMbps: 50 });
  });
});

describe('modules, services, power and wake (FR-141, FR-144, FR-145)', () => {
  it('starts, stops and restarts, audited', async () => {
    const fake = await env.enroll({ modules: ['management', 'storage', 'compute'] });
    const m = await env.svc.moduleAction(ACCOUNT, fake.deviceId!, 'compute', 'stop', {
      actor: 'user',
    });
    expect(m.state).toBe('stopped');
    expect((await env.svc.moduleAction(ACCOUNT, fake.deviceId!, 'compute', 'start')).state).toBe(
      'running',
    );
    const svc = await env.svc.serviceAction(ACCOUNT, fake.deviceId!, 'compute', 'restart');
    expect(svc.state).toBe('running');
    expect(await env.svc.serviceAction(ACCOUNT, fake.deviceId!, 'compute', 'status')).toMatchObject(
      { name: 'compute' },
    );
    await expect(env.svc.serviceAction(ACCOUNT, fake.deviceId!, 'nope', 'start')).rejects.toThrow(
      /no managed service/,
    );
    await expect(env.svc.moduleAction(ACCOUNT, fake.deviceId!, 'browser', 'start')).rejects.toThrow(
      /not installed/,
    );
    const actions = env.audit.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'device.module.stop',
        'device.module.start',
        'device.service.restart',
      ]),
    );
    expect(env.audit.every((a) => a.kind === 'device')).toBe(true);
    expect(env.events.names()).toContain('device.service.changed');
  });

  it('plans WoL, refuses unelevated changes and refuses disabled power actions', async () => {
    const fake = await env.enroll({ wakeMac: 'aa:bb:cc:dd:ee:ff' });
    expect(await env.svc.power(ACCOUNT, fake.deviceId!, { action: 'status' })).toMatchObject({
      wakeable: true,
      afterPowerLoss: 'unknown',
    });
    expect(await env.svc.power(ACCOUNT, fake.deviceId!, { action: 'wol-enable' })).toMatchObject({
      applied: false,
    });
    const err = await rejects(
      env.svc.power(ACCOUNT, fake.deviceId!, { action: 'wol-enable', apply: true }),
    );
    expect(err.details).toMatchObject({ reason: 'elevation_required' });
    const err2 = await rejects(env.svc.power(ACCOUNT, fake.deviceId!, { action: 'restart' }));
    expect(err2.details).toMatchObject({ reason: 'power_actions_disabled' });
    expect(env.audit.map((a) => a.action)).toContain('device.power.wol-enable');
  });

  it('wakes wakeable devices only, with a rate limit and a log', async () => {
    await env.close();
    env = await devicesEnv({
      settings: { wakesPerHour: () => Promise.resolve(2) },
      wol: {
        send: (mac) => {
          woken.push(mac);
          return Promise.resolve();
        },
      },
    });
    const fake = await env.enroll({ wakeMac: 'aa:bb:cc:dd:ee:ff' });
    const w = await env.svc.wake(ACCOUNT, fake.deviceId!);
    expect(w).toMatchObject({ status: 'sent', mac: 'aa:bb:cc:dd:ee:ff' });
    await env.svc.wake(ACCOUNT, fake.deviceId!);
    const err = await rejects(env.svc.wake(ACCOUNT, fake.deviceId!));
    expect(err.code).toBe('rate_limited');
    expect(woken).toEqual(['aa:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff']);
    const rows = env.db.raw
      .prepare('SELECT status FROM wake_request ORDER BY created_at, rowid')
      .all() as { status: string }[];
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent', 'rate_limited']);
    // An hour later it may wake again.
    env.clock.now += 3_600_001;
    await env.svc.wake(ACCOUNT, fake.deviceId!);
    const quiet = await env.enroll();
    expect((await rejects(env.svc.wake(ACCOUNT, quiet.deviceId!))).details).toMatchObject({
      reason: 'not_wakeable',
    });
    expect(env.audit.filter((a) => a.action === 'device.wake').length).toBe(4);
  });

  it('records a failed send', async () => {
    await env.close();
    env = await devicesEnv({ wol: { send: () => Promise.reject(new Error('no route')) } });
    const fake = await env.enroll({ wakeMac: 'aa:bb:cc:dd:ee:ff' });
    await expect(env.svc.wake(ACCOUNT, fake.deviceId!)).rejects.toThrow(/no route/);
    expect(env.db.raw.prepare('SELECT status, error FROM wake_request').get()).toMatchObject({
      status: 'failed',
      error: 'no route',
    });
  });
});

describe('updates (FR-148)', () => {
  function signer() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const bundle = (target: string, version: string, payload: string) => {
      const manifest = {
        target,
        version,
        channel: 'stable' as const,
        sha256: createHash('sha256').update(payload).digest('hex'),
        size: Buffer.byteLength(payload),
      };
      return {
        manifest,
        signature: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString(
          'base64url',
        ),
        payload: Buffer.from(payload).toString('base64'),
      };
    };
    return { pub, bundle };
  }

  it('applies module bundles first and the supervisor last', async () => {
    const s = signer();
    const fake = await env.enroll({ updateKey: s.pub, modules: ['management', 'storage'] });
    const results = await env.svc.pushUpdates(ACCOUNT, fake.deviceId!, [
      s.bundle('novad', '0.6.1', 'supervisor'),
      s.bundle('storage', '0.6.1', 'module'),
    ]);
    expect(results.map((r) => [r.target, r.status])).toEqual([
      ['storage', 'applied'],
      ['novad', 'staged'],
    ]);
    expect(results[0]).toMatchObject({ fromVersion: '0.6.0', toVersion: '0.6.1' });
    expect((await env.svc.updates(ACCOUNT, fake.deviceId!)).length).toBe(2);
    expect(env.events.events.filter((e) => e.name === 'device.update.result').length).toBe(2);
  });

  it('records a rollback and then refuses the supervisor bundle', async () => {
    const s = signer();
    const fake = await env.enroll({ updateKey: s.pub, modules: ['management', 'storage'] });
    const results = await env.svc.pushUpdates(ACCOUNT, fake.deviceId!, [
      s.bundle('storage', '0.6.1', 'fail-health-check'),
      s.bundle('novad', '0.6.1', 'supervisor'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rolled_back', 'refused']);
    expect(fake.novadVersion).toBe('0.6.0');
    // A bundle signed by another key is refused by the device.
    const other = signer();
    const [r] = await env.svc.pushUpdates(ACCOUNT, fake.deviceId!, [
      other.bundle('storage', '0.7.0', 'x'),
    ]);
    expect(r).toMatchObject({ status: 'refused' });
    expect(r!.detail).toMatch(/pinned key/);
    expect(env.audit.filter((a) => a.action === 'device.update').map((a) => a.result)).toEqual([
      'rolled_back',
      'refused',
      'refused',
    ]);
  });
});

describe('revocation', () => {
  it('cuts the device off and ends its connections', async () => {
    const fake: FakeDevice = await env.enroll();
    await env.svc.connect(ACCOUNT, {
      agentId: 'agent-1',
      deviceId: fake.deviceId!,
      capabilities: ['files'],
    });
    await env.svc.revoke(ACCOUNT, fake.deviceId!);
    await env.svc.revoke(ACCOUNT, fake.deviceId!);
    const hb = await fake.heartbeat();
    expect(hb.status).toBe(401);
    expect(fake.revoked).toBe(true);
    expect(await env.secrets.get(managementTokenRef(fake.deviceId!))).toBeNull();
    expect(await env.svc.activeConnection(ACCOUNT, 'agent-1')).toBeNull();
    await expect(
      env.svc.listFiles(ACCOUNT, fake.deviceId!, { kind: 'user', id: ACCOUNT }, '/'),
    ).rejects.toThrow(/not found/);
    await expect(env.svc.update(ACCOUNT, fake.deviceId!, { name: 'x' })).rejects.toThrow(/revoked/);
    expect(env.audit.map((a) => a.action)).toContain('device.revoke');
    await expect(env.svc.get(OTHER, fake.deviceId!)).rejects.toThrow(/not found/);
  });
});
