// D2 authorizations (ADR-096): the shared vectors verify with node:crypto alone (the bytes novad's
// verifier checks), the signer reproduces them, and the verifier refuses every way an
// authorization can be wrong: expired, early, another device, another kind, another body, a
// replay, a malformed or overlong one, a wrong key.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  DEVICE_AUTHZ_DOMAIN,
  DEVICE_AUTHZ_MAX_TTL_MS,
  MemoryReplayStore,
  authorizeDeviceBody,
  deviceAuthzBodySha256,
  deviceAuthzError,
  deviceAuthzSignedBytes,
  signDeviceAuthorization,
  verifyDeviceAuthorization,
  type DeviceAuthzKind,
  type DeviceAuthzPayload,
} from '../src/index.ts';
import { canonicalJson } from '../src/nodes/crypto.ts';

interface Vector {
  name: string;
  body: Record<string, unknown>;
  bodySha256: string;
  payload: DeviceAuthzPayload;
  canonical: string;
  signedBytesHex: string;
  signature: string;
  now: string;
}

const file = JSON.parse(
  readFileSync(new URL('./fixtures/device-authz-vectors.json', import.meta.url), 'utf8'),
) as { tag: string; seedHex: string; publicKey: string; deviceId: string; vectors: Vector[] };

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(file.seedHex, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const signer = {
  sign: (b: Uint8Array | string) =>
    sign(null, typeof b === 'string' ? Buffer.from(b, 'utf8') : b, privateKey),
};

describe('the shared D2 vectors', () => {
  it('has four vectors with the D2 tag and one fixed key', () => {
    expect(file.vectors).toHaveLength(4);
    expect(file.tag).toBe(DEVICE_AUTHZ_DOMAIN);
    expect(createPublicKey(privateKey).export({ format: 'jwk' }).x).toBe(file.publicKey);
    expect(new Set(file.vectors.map((v) => v.payload.kind)).size).toBe(4);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))('%s verifies with node:crypto', (_, v) => {
    // Independently of authz.ts: canonical JSON, the body hash, the signed bytes, the signature.
    expect(canonicalJson(v.payload)).toBe(v.canonical);
    const bodyHash = createHash('sha256').update(canonicalJson(v.body), 'utf8').digest('hex');
    expect(bodyHash).toBe(v.bodySha256);
    expect(v.payload.bodySha256).toBe(v.bodySha256);
    const bytes = Buffer.from(file.tag + v.canonical, 'utf8');
    expect(bytes.toString('hex')).toBe(v.signedBytesHex);
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: file.publicKey },
      format: 'jwk',
    });
    expect(verify(null, bytes, key, Buffer.from(v.signature, 'base64url'))).toBe(true);
    // A changed byte no longer verifies.
    const tampered = Buffer.from(file.tag + v.canonical.replace('dev-1', 'dev-2'), 'utf8');
    expect(verify(null, tampered, key, Buffer.from(v.signature, 'base64url'))).toBe(false);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))(
    '%s: the signer reproduces it and the verifier accepts it',
    (_, v) => {
      const auth = signDeviceAuthorization(signer, {
        kind: v.payload.kind,
        deviceId: v.payload.deviceId,
        approvalId: v.payload.approvalId,
        changeId: v.payload.changeId,
        body: v.body,
        now: new Date(v.payload.issuedAt),
        ttlMs: Date.parse(v.payload.expiresAt) - Date.parse(v.payload.issuedAt),
      });
      expect(auth).toEqual({ payload: v.payload, signature: v.signature });
      expect(deviceAuthzSignedBytes(v.payload).toString('hex')).toBe(v.signedBytesHex);
      const verdict = verifyDeviceAuthorization({
        authorization: auth,
        publicKey: file.publicKey,
        deviceId: file.deviceId,
        kind: v.payload.kind,
        body: { ...v.body, authorization: auth },
        now: new Date(v.now),
      });
      expect(verdict).toEqual({ ok: true, payload: v.payload });
    },
  );
});

describe('verifying an authorization', () => {
  const T0 = new Date('2026-10-19T12:00:00.000Z');
  const body = { planId: 'p', snapshotId: 's', changes: [{ key: 'wol', value: 'LanOnly' }] };
  const make = (kind: DeviceAuthzKind = 'firmware.apply', ttlMs = 300_000) =>
    authorizeDeviceBody(signer, {
      kind,
      deviceId: 'dev-1',
      approvalId: 'appr-1',
      body,
      now: T0,
      ttlMs,
    });
  const check = (
    b: Record<string, unknown>,
    over: Partial<Parameters<typeof verifyDeviceAuthorization>[0]> = {},
  ) =>
    verifyDeviceAuthorization({
      authorization: b.authorization,
      publicKey: file.publicKey,
      deviceId: 'dev-1',
      kind: 'firmware.apply',
      body: b,
      now: new Date(T0.getTime() + 1000),
      ...over,
    });
  const reason = (v: ReturnType<typeof check>) => (v.ok ? 'ok' : v.reason);

  it('accepts once, then refuses the replay with 409', () => {
    const replay = new MemoryReplayStore();
    const b = make();
    expect(reason(check(b, { replay }))).toBe('ok');
    const again = check(b, { replay });
    expect(reason(again)).toBe('replayed');
    if (!again.ok)
      expect(deviceAuthzError(again)).toEqual({
        status: 409,
        code: 'conflict',
        details: { reason: 'replayed' },
      });
    // A fresh authorization for the same body has a new change id.
    expect(reason(check(make(), { replay }))).toBe('ok');
  });

  it('refuses expired and future authorizations, allowing 120 s of skew', () => {
    const b = make('firmware.apply', 60_000);
    const at = (ms: number) => reason(check(b, { now: new Date(T0.getTime() + ms) }));
    expect(at(60_000 + 119_000)).toBe('ok');
    expect(at(60_000 + 121_000)).toBe('authorization_expired');
    expect(at(-119_000)).toBe('ok');
    expect(at(-121_000)).toBe('authorization_expired');
  });

  it('refuses another device, another kind and another body as a mismatch (403)', () => {
    const b = make();
    expect(reason(check(b, { deviceId: 'dev-2' }))).toBe('authorization_mismatch');
    expect(reason(check(b, { kind: 'firmware.rollback' }))).toBe('authorization_mismatch');
    const changed = { ...b, changes: [{ key: 'wol', value: 'LanWlan' }] };
    const v = check(changed);
    expect(reason(v)).toBe('authorization_mismatch');
    if (!v.ok)
      expect(deviceAuthzError(v)).toEqual({
        status: 403,
        code: 'policy_denied',
        details: { reason: 'authorization_mismatch' },
      });
  });

  it('refuses a missing, malformed or forged authorization as invalid', () => {
    const b = make();
    expect(reason(check({ ...body }))).toBe('authorization_invalid');
    expect(reason(check({ ...body, authorization: { payload: {}, signature: 'x' } }))).toBe(
      'authorization_invalid',
    );
    const extra = { ...b.authorization, payload: { ...b.authorization.payload, extra: 1 } };
    expect(reason(check({ ...b, authorization: extra }))).toBe('authorization_invalid');
    const badSig = { ...b.authorization, signature: 'A'.repeat(86) };
    expect(reason(check({ ...b, authorization: badSig }))).toBe('authorization_invalid');
    const shortSig = { ...b.authorization, signature: 'abc' };
    expect(reason(check({ ...b, authorization: shortSig }))).toBe('authorization_invalid');
    // Signed by another key.
    const other = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, 7)]),
      format: 'der',
      type: 'pkcs8',
    });
    const forged = authorizeDeviceBody(
      { sign: (x) => sign(null, Buffer.from(x), other) },
      { kind: 'firmware.apply', deviceId: 'dev-1', approvalId: 'a', body, now: T0 },
    );
    expect(reason(check(forged))).toBe('authorization_invalid');
    expect(reason(check(b, { publicKey: 'not-a-key' }))).toBe('authorization_invalid');
    // A KeyObject works as the pinned key too.
    const key = createPublicKey(privateKey);
    expect(reason(check(b, { publicKey: key }))).toBe('ok');
  });

  it('refuses an authorization signed to live longer than 10 minutes', () => {
    const payload: DeviceAuthzPayload = {
      v: 1,
      kind: 'firmware.apply',
      deviceId: 'dev-1',
      changeId: '01929d6e-4000-7000-8000-00000000ffff',
      bodySha256: deviceAuthzBodySha256(body),
      approvalId: 'appr-1',
      issuedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + DEVICE_AUTHZ_MAX_TTL_MS + 1).toISOString(),
    };
    const signature = signer.sign(deviceAuthzSignedBytes(payload)).toString('base64url');
    expect(reason(check({ ...body, authorization: { payload, signature } }))).toBe(
      'authorization_invalid',
    );
    const inverted = { ...payload, expiresAt: payload.issuedAt };
    const sig2 = signer.sign(deviceAuthzSignedBytes(inverted)).toString('base64url');
    expect(reason(check({ ...body, authorization: { payload: inverted, signature: sig2 } }))).toBe(
      'authorization_invalid',
    );
  });

  it('never hashes the BIOS admin password, and accepts a body hashed with it too', () => {
    const withPassword = { ...body, adminPassword: 'hunter2' };
    const signed = authorizeDeviceBody(signer, {
      kind: 'firmware.apply',
      deviceId: 'dev-1',
      approvalId: 'appr-1',
      body: withPassword,
      now: T0,
    });
    expect(signed.authorization.payload.bodySha256).toBe(deviceAuthzBodySha256(body));
    expect(reason(check(signed))).toBe('ok');
    // A signer that did hash it (novad accepts both forms).
    const full = {
      v: 1 as const,
      kind: 'firmware.apply' as const,
      deviceId: 'dev-1',
      changeId: '01929d6e-4000-7000-8000-00000000fffe',
      bodySha256: deviceAuthzBodySha256(withPassword),
      approvalId: 'appr-1',
      issuedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 60_000).toISOString(),
    };
    const sig = signer.sign(deviceAuthzSignedBytes(full)).toString('base64url');
    expect(
      reason(check({ ...withPassword, authorization: { payload: full, signature: sig } })),
    ).toBe('ok');
  });

  it('signs nothing for an unknown kind, an overlong life or an identity that is not loaded', () => {
    expect(() =>
      signDeviceAuthorization(signer, {
        kind: 'firmware.erase' as DeviceAuthzKind,
        deviceId: 'd',
        approvalId: 'a',
        body: {},
      }),
    ).toThrow(TypeError);
    expect(() =>
      signDeviceAuthorization(signer, {
        kind: 'boot.set',
        deviceId: 'd',
        approvalId: 'a',
        body: {},
        ttlMs: DEVICE_AUTHZ_MAX_TTL_MS + 1,
      }),
    ).toThrow(TypeError);
    let caught: unknown;
    try {
      signDeviceAuthorization(
        {
          sign: () => {
            throw new Error('the Hub identity is not loaded');
          },
        },
        { kind: 'boot.revert', deviceId: 'd', approvalId: 'a', body: {} },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NovaError);
    expect((caught as NovaError).details).toEqual({ reason: 'identity_unavailable' });
    // Defaults: a fresh UUIDv7 change id and a 5-minute life.
    const a = signDeviceAuthorization(signer, {
      kind: 'device.decommission',
      deviceId: 'd',
      approvalId: 'a',
      body: { purge: false },
    });
    expect(a.payload.changeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(Date.parse(a.payload.expiresAt) - Date.parse(a.payload.issuedAt)).toBe(300_000);
  });

  it('bounds the in-memory replay store and forgets expired ids', () => {
    let now = 0;
    const store = new MemoryReplayStore({ max: 2, now: () => now });
    store.add('a', 10);
    store.add('b', 100);
    expect(store.has('a')).toBe(true);
    now = 50;
    expect(store.has('a')).toBe(false);
    store.add('c', 200);
    store.add('d', 300);
    expect(store.size).toBe(2);
    expect(store.has('d')).toBe(true);
  });
});
