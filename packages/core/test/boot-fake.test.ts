// The D5 fake novad on its own: it checks D2 authorizations independently of the Hub's signer, so
// it must accept the shared test vector the Rust verifier reads (packages/core/test/fixtures/
// device-authz-vectors.json) and refuse it outside its window; and its bootloader keeps one-shot
// semantics (the pending entry boots once, then the default).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOT_SET_PATH, BOOT_STATUS_PATH, FakeBootDevice } from '../src/index.ts';

interface Vector {
  name: string;
  body: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
}
const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/device-authz-vectors.json'), 'utf8'),
) as { publicKey: string; deviceId: string; vectors: Vector[] };
const vector = fixtures.vectors.find((v) => v.payload.kind === 'boot.set')!;

function fakeAt(ms: number, opts: { lowLevelBoot?: boolean } = {}) {
  return new FakeBootDevice({
    hubPublicKey: fixtures.publicKey,
    deviceId: fixtures.deviceId,
    entries: [
      { id: 'auto-linux.efi', title: 'Linux' },
      { id: String(vector.body.entryId), title: 'Linux 6.18' },
    ],
    lowLevelBoot: opts.lowLevelBoot ?? true,
    now: () => new Date(ms),
  });
}

const issued = Date.parse(String(vector.payload.issuedAt));
const request = {
  ...vector.body,
  authorization: { payload: vector.payload, signature: vector.signature },
};

describe('the fake novad verifier', () => {
  it("accepts the shared boot.set vector signed by K's signer", () => {
    const fake = fakeAt(issued + 1_000);
    const r = fake.handle(BOOT_SET_PATH, request);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fake.oneShot).toBe(vector.body.entryId);
    expect(fake.rebootsRequested).toBe(0);
  });

  it('refuses it after its window (with 120 s of skew) and before', () => {
    const late = fakeAt(Date.parse(String(vector.payload.expiresAt)) + 121_000);
    expect(late.handle(BOOT_SET_PATH, request).body).toMatchObject({
      error: { code: 'policy_denied', details: { reason: 'authorization_expired' } },
    });
    const early = fakeAt(issued - 121_000);
    expect(early.handle(BOOT_SET_PATH, request).body).toMatchObject({
      error: { details: { reason: 'authorization_expired' } },
    });
    expect(fakeAt(issued - 119_000).handle(BOOT_SET_PATH, request).status).toBe(200);
  });

  it('refuses it while low-level boot is off, whatever the authorization', () => {
    const r = fakeAt(issued + 1_000, { lowLevelBoot: false }).handle(BOOT_SET_PATH, request);
    expect(r).toMatchObject({
      status: 403,
      body: { error: { details: { reason: 'low_level_boot_off' } } },
    });
  });

  it('refuses a missing or unsigned authorization', () => {
    const fake = fakeAt(issued + 1_000);
    expect(fake.handle(BOOT_SET_PATH, vector.body).body).toMatchObject({
      error: { details: { reason: 'authorization_invalid' } },
    });
    expect(
      fake.handle(BOOT_SET_PATH, {
        ...vector.body,
        authorization: { payload: vector.payload, signature: 'A'.repeat(86) },
      }).body,
    ).toMatchObject({ error: { details: { reason: 'authorization_invalid' } } });
  });
});

describe('the fake bootloader', () => {
  it('boots a one-shot entry once, then the default again', () => {
    const fake = fakeAt(issued + 1_000);
    expect(fake.handle(BOOT_SET_PATH, request).status).toBe(200);
    fake.powerCycle();
    expect(fake.booted).toBe(vector.body.entryId);
    expect(fake.takeEvents()).toMatchObject([{ kind: 'boot.watchdog.ok' }]);
    fake.powerCycle();
    expect(fake.booted).toBe('auto-linux.efi');
    expect(fake.takeEvents()).toEqual([]);
    expect(fake.handle(BOOT_STATUS_PATH, {}).body).toMatchObject({
      booted: 'auto-linux.efi',
      pending: null,
      last: { result: 'ok', entryId: vector.body.entryId },
    });
  });

  it('answers 401 to a wrong management token and 404 to an unknown route', () => {
    const fake = new FakeBootDevice({
      hubPublicKey: fixtures.publicKey,
      deviceId: 'd',
      managementToken: 'nvdm_x',
    });
    expect(fake.handle(BOOT_STATUS_PATH, {}, 'nvdm_y').status).toBe(401);
    expect(fake.handle('/agent/v1/boot/nope', {}, 'nvdm_x').status).toBe(404);
    expect(fake.handle(BOOT_STATUS_PATH, [], 'nvdm_x').status).toBe(400);
  });
});
