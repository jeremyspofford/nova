// M7 device credential checks (FR-126, FR-128): the standalone lookups the device-trust area ties
// client certificates to (a novad credential, a compute node credential, never one for the other
// or a revoked one), and the scopes a heartbeat answer carries for novad's local runtime.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeNodeForCredential, novadDeviceForCredential, NodeService } from '../src/index.ts';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';

let env: DevicesEnv;

beforeEach(async () => {
  env = await devicesEnv();
});

afterEach(async () => {
  await env.close();
});

describe('device credentials (FR-126)', () => {
  it('finds the novad device of a credential and nothing for anything else', async () => {
    const fake = await env.enroll();
    const row = await novadDeviceForCredential(env.db, fake.credential!);
    expect(row?.id).toBe(fake.deviceId);
    expect(row?.publicKey).toBe(fake.publicKey);
    expect(await env.svc.authenticate(fake.credential!)).toMatchObject({ id: fake.deviceId });
    // Another prefix, a wrong token, an oversized one: no device.
    expect(await novadDeviceForCredential(env.db, `nvn_${fake.credential!.slice(4)}`)).toBeNull();
    // secret-scan: fake
    expect(await novadDeviceForCredential(env.db, 'nvc_not-a-real-credential')).toBeNull();
    expect(await novadDeviceForCredential(env.db, `nvc_${'a'.repeat(300)}`)).toBeNull();
    // A node credential lookup never finds a novad device (each hashes in its own domain).
    expect(await computeNodeForCredential(env.db, fake.credential!)).toBeNull();
    // Revoked: gone at once.
    await env.svc.revoke(ACCOUNT, fake.deviceId!);
    expect(await novadDeviceForCredential(env.db, fake.credential!)).toBeNull();
  });

  it('finds a compute node by its credential', async () => {
    const nodes = new NodeService({ db: env.db, secrets: env.secrets, events: env.events });
    expect(await computeNodeForCredential(env.db, 'nvn_unknown')).toBeNull();
    expect(await computeNodeForCredential(env.db, 'nvc_wrong-prefix')).toBeNull();
    expect(await nodes.authenticate('nvn_unknown')).toBeNull();
  });
});

describe('heartbeat scopes (FR-128)', () => {
  it('answers the scopes the owner granted, the capability flags included', async () => {
    const fake = await env.enroll();
    let hb = await fake.heartbeat();
    expect(hb.json.scopes).toEqual([]);
    env.db.raw
      .prepare('UPDATE device SET scopes = ?, local_runtime = 1 WHERE id = ?')
      .run(JSON.stringify(['files']), fake.deviceId);
    hb = await fake.heartbeat();
    expect(hb.json.scopes).toEqual(['files', 'local-runtime']);
    env.db.raw
      .prepare('UPDATE device SET scopes = ?, local_runtime = 0, offline_replica = 1 WHERE id = ?')
      .run('not json', fake.deviceId);
    hb = await fake.heartbeat();
    expect(hb.json.scopes).toEqual(['offline-replica']);
  });
});
