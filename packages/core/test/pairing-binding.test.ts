// Enrollment tokens from Add Device are bound to the approved key and device record (FR-132,
// ADR-094): novad's `/agent/v1/register` and a compute node's `/node/v1/register` must present that
// key and activate that record (keeping the approved name and scopes); a revoked or unknown record
// refuses them; unbound owner tokens keep working as before. Revoking either kind blocks its key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { buildCapability, generateKeys, newJobToken, signDocument } from '@nova/compute';
import {
  FakeDevice,
  MemoryEventSink,
  NodeService,
  PairingService,
  keyFingerprint,
} from '../src/index.ts';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';

let env: DevicesEnv;

beforeEach(async () => {
  env = await devicesEnv();
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

/** A pending device record as an Add Device approval leaves it. */
function pendingDevice(publicKey: string, kind: 'client' | 'compute', id: string): void {
  const iso = new Date(env.clock.now).toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key, roles,
         scopes, status, created_at, updated_at)
       VALUES (?, ?, 'Approved name', ?, 'linux', ?, ?, ?, '["files"]', 'pending', ?, ?)`,
    )
    .run(id, ACCOUNT, kind, keyFingerprint(publicKey), publicKey, JSON.stringify([kind]), iso, iso);
}

const DEVICE_ID = '01920000-0000-7000-8000-0000000000d1';

describe('novad registration with a bound token', () => {
  it('activates the approved record with the approved key only', async () => {
    const fake = new FakeDevice({ name: 'reported-name' });
    env.devices.push(fake);
    pendingDevice(fake.publicKey, 'client', DEVICE_ID);
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client'], env.hubUrl, {
      publicKey: fake.publicKey,
      deviceId: DEVICE_ID,
    });
    const scopes = env.db.raw.prepare('SELECT scopes FROM add_device_request').get() as {
      scopes: string;
    };
    expect(JSON.parse(scopes.scopes)).toEqual({
      novad: true,
      roles: ['client'],
      bind: { publicKey: fake.publicKey, deviceId: DEVICE_ID },
    });
    await fake.enroll(env.hubUrl, t.token);
    expect(fake.deviceId).toBe(DEVICE_ID);
    const row = env.db.raw.prepare('SELECT * FROM device').all() as Record<string, unknown>[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      id: DEVICE_ID,
      name: 'Approved name',
      status: 'active',
      scopes: '["files"]',
    });
    expect((await env.svc.get(ACCOUNT, DEVICE_ID)).name).toBe('Approved name');
    expect((await fake.heartbeat()).status).toBe(200);
    expect(env.events.events.find((e) => e.name === 'device.registered')?.payload).toMatchObject({
      deviceId: DEVICE_ID,
      name: 'Approved name',
    });
    expect(env.audit.find((a) => a.action === 'device.register')?.detail).toMatchObject({
      addDevice: true,
    });
  });

  it('refuses another key and a record that is not waiting, burning the token', async () => {
    const approved = new FakeDevice();
    const intruder = new FakeDevice();
    env.devices.push(approved, intruder);
    pendingDevice(approved.publicKey, 'client', DEVICE_ID);
    const bind = { publicKey: approved.publicKey, deviceId: DEVICE_ID };
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client'], env.hubUrl, bind);
    await expect(intruder.enroll(env.hubUrl, t.token)).rejects.toThrow(/403.*another device key/s);
    // The token is burned even so.
    await expect(approved.enroll(env.hubUrl, t.token)).rejects.toThrow(/401/);

    env.db.raw.prepare("UPDATE device SET status = 'revoked' WHERE id = ?").run(DEVICE_ID);
    const t2 = await env.svc.createEnrollToken(ACCOUNT, ['client'], env.hubUrl, bind);
    await expect(approved.enroll(env.hubUrl, t2.token)).rejects.toThrow(/409.*not waiting/s);
  });

  it('keeps only roles the owner approved (review finding 3)', async () => {
    // The reviewer's probe: a token made for `client`, a document claiming hub + wake-helper +
    // compute. The device gets `client` only.
    const t = await env.svc.createEnrollToken(ACCOUNT, ['client'], env.hubUrl);
    const greedy = new FakeDevice({
      name: 'x',
      roles: ['hub', 'wake-helper', 'compute'],
      modules: ['management'],
    });
    env.devices.push(greedy);
    await greedy.enroll(env.hubUrl, t.token);
    const view = await env.svc.get(ACCOUNT, greedy.deviceId!);
    expect(view.roles).toEqual(['client']);
    expect(env.db.raw.prepare('SELECT kind FROM device WHERE id = ?').get(greedy.deviceId)).toEqual(
      {
        kind: 'client',
      },
    );
    // A document may narrow the approved roles, never widen them.
    const t2 = await env.svc.createEnrollToken(ACCOUNT, ['client', 'wake-helper'], env.hubUrl);
    const helper = new FakeDevice({ name: 'y', roles: ['wake-helper', 'hub'] });
    env.devices.push(helper);
    await helper.enroll(env.hubUrl, t2.token);
    expect((await env.svc.get(ACCOUNT, helper.deviceId!)).roles).toEqual(['wake-helper']);
  });

  it('tells Add Device about revocations, which blocks the key', async () => {
    const pairing = new PairingService({ db: env.db, events: env.events });
    const seen: string[] = [];
    const off = env.svc.onRevoked(async (accountId, deviceId) => {
      seen.push(deviceId);
      await pairing.deviceRevoked(deviceId, { accountId });
    });
    env.svc.onRevoked(() => {
      throw new Error('a failing hook does not undo the revocation');
    });
    const fake = await env.enroll();
    await env.svc.revoke(ACCOUNT, fake.deviceId!);
    expect(seen).toEqual([fake.deviceId]);
    expect(await pairing.isKeyRevoked(fake.publicKey)).toBe(true);
    expect((await env.svc.get(ACCOUNT, fake.deviceId!)).status).toBe('revoked');
    off();
  });
});

describe('compute node registration with a bound token', () => {
  let nodes: NodeService;
  let events: MemoryEventSink;

  beforeEach(() => {
    events = new MemoryEventSink();
    nodes = new NodeService({ db: env.db, secrets: new MemorySecretStore(), events });
  });

  function body(token: string, keys = generateKeys()) {
    const capability = buildCapability({
      deviceId: 'node-1',
      name: 'gpu',
      backendKind: 'ollama',
      models: ['llama3'],
      maxConcurrentJobs: 1,
      hardware: { arch: 'x86_64', cores: 4, ramBytes: 8e9, gpus: [] },
      os: { family: 'linux', version: '6.1' },
    });
    return {
      enrollToken: token,
      name: 'reported',
      endpoint: 'http://10.0.0.9:7420',
      publicKey: keys.publicKey,
      capability,
      signature: signDocument(capability, keys.privateKeyPem),
      jobToken: newJobToken(),
      protocolVersions: [1],
    };
  }

  it('activates the approved node with its key and refuses others', async () => {
    const keys = generateKeys();
    pendingDevice(keys.publicKey, 'compute', DEVICE_ID);
    const bind = { publicKey: keys.publicKey, deviceId: DEVICE_ID };
    expect((await nodes.list(ACCOUNT))[0]).toMatchObject({ id: DEVICE_ID, status: 'pending' });

    const wrong = await nodes.createEnrollToken(ACCOUNT, bind);
    const e = await rejects(nodes.register(body(wrong.token)));
    expect(e.code).toBe('policy_denied');
    expect(e.details).toEqual({ reason: 'key_mismatch' });

    const right = await nodes.createEnrollToken(ACCOUNT, bind);
    const out = await nodes.register(body(right.token, keys));
    expect(out.nodeId).toBe(DEVICE_ID);
    const [listed] = await nodes.list(ACCOUNT);
    expect(listed).toMatchObject({ id: DEVICE_ID, name: 'Approved name', status: 'active' });
    expect(events.events.find((x) => x.name === 'node.registered')?.payload).toMatchObject({
      nodeId: DEVICE_ID,
      name: 'Approved name',
    });

    // The node is active now: a second bound token for it is refused.
    const again = await nodes.createEnrollToken(ACCOUNT, bind);
    const busy = await rejects(nodes.register(body(again.token, keys)));
    expect(busy.details).toEqual({ reason: 'device_not_pending' });
  });

  it('still takes unbound owner tokens, and blocks a revoked node key', async () => {
    const pairing = new PairingService({ db: env.db, events });
    nodes.onRevoked((nodeId) => void pairing.deviceRevoked(nodeId, { audit: true }));
    const keys = generateKeys();
    const { token } = await nodes.createEnrollToken(ACCOUNT);
    const out = await nodes.register(body(token, keys));
    await nodes.revoke(ACCOUNT, out.nodeId);
    for (let i = 0; i < 50 && !(await pairing.isKeyRevoked(keys.publicKey)); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(await pairing.isKeyRevoked(keys.publicKey)).toBe(true);
  });
});
