// Hub-signed authorizations for privileged device actions (ADR-096 D2): firmware apply and
// rollback, boot set, commit and revert, and decommission. novad refuses these without a valid
// authorization whatever its management token says, so a stolen token cannot change firmware.
//
// The object is `{v: 1, kind, deviceId, changeId, bodySha256, approvalId, issuedAt, expiresAt}`,
// signed with the Hub identity key (Ed25519) over `"nova-device-authz-v1\n" + canonicalJson`, the
// signature base64url, sent as the body field `authorization: {payload, signature}`. `bodySha256`
// is the hex SHA-256 of the canonical JSON of the request body without its `authorization`; the
// Hub also leaves out a short-lived `adminPassword` (the BIOS admin password, firmware only), so
// no hash ever covers a secret. novad accepts either form.
// Both sides share test vectors (packages/core/test/fixtures/device-authz-vectors.json); novad's
// verifier is services/novad/src/authz.rs. Used by the firmware (K) and boot (L) areas and by
// decommission (P).
import { createHash, verify as edVerify, type KeyObject } from 'node:crypto';
import { NovaError, uuidv7 } from '@nova/shared';
import { canonicalJson, ed25519PublicKey, SIGNATURE_PATTERN } from '../nodes/crypto.ts';

export { canonicalJson };

/** The domain prefix of the signed bytes (D2). */
export const DEVICE_AUTHZ_DOMAIN = 'nova-device-authz-v1\n';

export const DEVICE_AUTHZ_KINDS = [
  'firmware.apply',
  'firmware.rollback',
  'boot.set',
  'boot.commit',
  'boot.revert',
  'device.decommission',
] as const;
export type DeviceAuthzKind = (typeof DEVICE_AUTHZ_KINDS)[number];

/** The longest an authorization may live (`expiresAt <= issuedAt + 10 min`). */
export const DEVICE_AUTHZ_MAX_TTL_MS = 10 * 60 * 1000;
/** The default lifetime the Hub gives one: long enough for a slow device, short for a leak. */
export const DEVICE_AUTHZ_DEFAULT_TTL_MS = 5 * 60 * 1000;
/** The clock skew a verifier allows on both ends of the window. */
export const DEVICE_AUTHZ_SKEW_MS = 120 * 1000;
/** How long a verifier keeps a used `changeId` (replays inside it are refused). */
export const DEVICE_AUTHZ_REPLAY_MS = 24 * 60 * 60 * 1000;

export interface DeviceAuthzPayload {
  v: 1;
  kind: DeviceAuthzKind;
  deviceId: string;
  /** A UUIDv7 never reused: one per authorization, so a retry gets a new one. */
  changeId: string;
  bodySha256: string;
  approvalId: string;
  /** ISO-8601 UTC with milliseconds (`Date.prototype.toISOString`). */
  issuedAt: string;
  expiresAt: string;
}

export interface DeviceAuthorization {
  payload: DeviceAuthzPayload;
  /** Ed25519 over `DEVICE_AUTHZ_DOMAIN + canonicalJson(payload)`, base64url without padding. */
  signature: string;
}

/** Anything that signs with the Hub identity key (`HubIdentityHandle` from the trust area). */
export interface DeviceAuthzSigner {
  sign(bytes: Uint8Array | string): Buffer;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Body fields a hash never covers besides `authorization`: secrets sent for one call only. */
export const DEVICE_AUTHZ_UNHASHED_SECRETS = ['adminPassword'] as const;

/**
 * Hex SHA-256 of the canonical JSON of a request body without its `authorization` field and,
 * with `withoutSecrets` (what the Hub signs), without `adminPassword` either.
 */
export function deviceAuthzBodySha256(
  body: Record<string, unknown>,
  withoutSecrets = false,
): string {
  const rest: Record<string, unknown> = { ...body };
  delete rest.authorization;
  if (withoutSecrets) for (const k of DEVICE_AUTHZ_UNHASHED_SECRETS) delete rest[k];
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
}

/** The exact bytes the signature covers. */
export function deviceAuthzSignedBytes(payload: DeviceAuthzPayload): Buffer {
  return Buffer.from(DEVICE_AUTHZ_DOMAIN + canonicalJson(payload), 'utf8');
}

export interface DeviceAuthzInput {
  kind: DeviceAuthzKind;
  deviceId: string;
  approvalId: string;
  /**
   * The request body the authorization covers (an `authorization` field in it is ignored, and so
   * is `adminPassword`).
   */
  body: Record<string, unknown>;
  /** A fresh UUIDv7 by default; pass one only to record it before signing. */
  changeId?: string;
  now?: Date;
  /** At most `DEVICE_AUTHZ_MAX_TTL_MS`; `DEVICE_AUTHZ_DEFAULT_TTL_MS` by default. */
  ttlMs?: number;
}

/**
 * Sign an authorization for one privileged request. The caller has already checked the four
 * conditions of D2 (the owner asked, the toggle is on, an approval for exactly this change is
 * approved, the device is not revoked); this only builds and signs the object.
 */
export function signDeviceAuthorization(
  signer: DeviceAuthzSigner,
  input: DeviceAuthzInput,
): DeviceAuthorization {
  if (!(DEVICE_AUTHZ_KINDS as readonly string[]).includes(input.kind))
    throw new TypeError(`unknown authorization kind ${String(input.kind)}`);
  const ttl = input.ttlMs ?? DEVICE_AUTHZ_DEFAULT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > DEVICE_AUTHZ_MAX_TTL_MS)
    throw new TypeError('an authorization lives between 1 ms and 10 minutes');
  const now = input.now ?? new Date();
  const payload: DeviceAuthzPayload = {
    v: 1,
    kind: input.kind,
    deviceId: input.deviceId,
    changeId: input.changeId ?? uuidv7(),
    bodySha256: deviceAuthzBodySha256(input.body, true),
    approvalId: input.approvalId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  let signature: string;
  try {
    signature = signer.sign(deviceAuthzSignedBytes(payload)).toString('base64url');
  } catch (err) {
    // An identity that is not loaded signs nothing: fail closed with the reason.
    throw new NovaError('conflict', 'the Hub identity key is not available to sign with', {
      details: { reason: 'identity_unavailable' },
      cause: err,
    });
  }
  return { payload, signature };
}

/** The body with its authorization attached, ready to send. */
export function authorizeDeviceBody<T extends Record<string, unknown>>(
  signer: DeviceAuthzSigner,
  input: Omit<DeviceAuthzInput, 'body'> & { body: T },
): T & { authorization: DeviceAuthorization } {
  const authorization = signDeviceAuthorization(signer, input);
  return { ...input.body, authorization };
}

// ---- verification (the device's side; the Hub uses it in tests and fakes) ---------------------

export type DeviceAuthzRefusal =
  'authorization_invalid' | 'authorization_expired' | 'authorization_mismatch' | 'replayed';

/** Used change ids; a verifier keeps each until it expires (24 h by default). */
export interface DeviceAuthzReplayStore {
  has(changeId: string): boolean;
  add(changeId: string, untilMs: number): void;
}

/** A bounded in-memory replay store (tests and fakes; novad keeps its own on disk). */
export class MemoryReplayStore implements DeviceAuthzReplayStore {
  readonly #seen = new Map<string, number>();
  readonly #max: number;
  readonly #now: () => number;
  constructor(opts: { max?: number; now?: () => number } = {}) {
    this.#max = opts.max ?? 10_000;
    this.#now = opts.now ?? Date.now;
  }
  has(changeId: string): boolean {
    const until = this.#seen.get(changeId);
    if (until === undefined) return false;
    if (until < this.#now()) {
      this.#seen.delete(changeId);
      return false;
    }
    return true;
  }
  add(changeId: string, untilMs: number): void {
    if (this.#seen.size >= this.#max) {
      const now = this.#now();
      for (const [k, t] of this.#seen) if (t < now) this.#seen.delete(k);
      // Still full: the oldest entry goes (bounded memory for tests and fakes).
      if (this.#seen.size >= this.#max) {
        const first = this.#seen.keys().next();
        if (!first.done) this.#seen.delete(first.value);
      }
    }
    this.#seen.set(changeId, untilMs);
  }
  get size(): number {
    return this.#seen.size;
  }
}

export interface DeviceAuthzVerifyInput {
  /** The `authorization` field as received (untrusted). */
  authorization: unknown;
  /** The pinned Hub key: raw Ed25519 base64url, or a KeyObject. */
  publicKey: string | KeyObject;
  /** This device's id. */
  deviceId: string;
  /** The kind the route expects. */
  kind: DeviceAuthzKind;
  /** The full request body (its `authorization` field is left out of the hash). */
  body: Record<string, unknown>;
  now?: Date;
  /** Without one, replays are not checked (the caller does it). */
  replay?: DeviceAuthzReplayStore;
  skewMs?: number;
}

export type DeviceAuthzVerdict =
  | { ok: true; payload: DeviceAuthzPayload }
  | { ok: false; reason: DeviceAuthzRefusal; message: string };

function refuse(reason: DeviceAuthzRefusal, message: string): DeviceAuthzVerdict {
  return { ok: false, reason, message };
}

/** Parse the payload strictly: exactly the D2 fields with the D2 types. */
function parsePayload(v: unknown): DeviceAuthzPayload | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v).sort();
  const want = [
    'approvalId',
    'bodySha256',
    'changeId',
    'deviceId',
    'expiresAt',
    'issuedAt',
    'kind',
    'v',
  ];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return null;
  const str = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max;
  if (v.v !== 1) return null;
  if (typeof v.kind !== 'string' || !(DEVICE_AUTHZ_KINDS as readonly string[]).includes(v.kind))
    return null;
  if (!str(v.deviceId, 100) || !str(v.changeId, 100) || !str(v.approvalId, 100)) return null;
  if (typeof v.bodySha256 !== 'string' || !HEX64.test(v.bodySha256)) return null;
  if (typeof v.issuedAt !== 'string' || !ISO.test(v.issuedAt)) return null;
  if (typeof v.expiresAt !== 'string' || !ISO.test(v.expiresAt)) return null;
  return v as unknown as DeviceAuthzPayload;
}

/**
 * Check an authorization as D2 says novad does: a valid signature by the pinned Hub key, this
 * device, the route's kind, the body's hash, the time window with skew, and no replay. The fakes
 * of the firmware and boot tests use it; the shared vectors keep it and novad's in agreement.
 */
export function verifyDeviceAuthorization(input: DeviceAuthzVerifyInput): DeviceAuthzVerdict {
  const a = input.authorization;
  if (!isRecord(a)) return refuse('authorization_invalid', 'no authorization');
  const payload = parsePayload(a.payload);
  if (!payload) return refuse('authorization_invalid', 'a malformed authorization');
  if (typeof a.signature !== 'string' || !SIGNATURE_PATTERN.test(a.signature))
    return refuse('authorization_invalid', 'a malformed signature');
  const key =
    typeof input.publicKey === 'string' ? ed25519PublicKey(input.publicKey) : input.publicKey;
  if (!key) return refuse('authorization_invalid', 'no usable Hub key');
  let good: boolean;
  try {
    good = edVerify(
      null,
      deviceAuthzSignedBytes(payload),
      key,
      Buffer.from(a.signature, 'base64url'),
    );
  } catch {
    good = false;
  }
  if (!good) return refuse('authorization_invalid', 'the signature does not verify');
  if (payload.deviceId !== input.deviceId)
    return refuse('authorization_mismatch', 'the authorization names another device');
  if (payload.kind !== input.kind)
    return refuse('authorization_mismatch', `the authorization is for ${payload.kind}`);
  if (
    payload.bodySha256 !== deviceAuthzBodySha256(input.body) &&
    payload.bodySha256 !== deviceAuthzBodySha256(input.body, true)
  )
    return refuse('authorization_mismatch', 'the request body is not the one authorized');
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued)
    return refuse('authorization_invalid', 'a malformed time window');
  if (expires - issued > DEVICE_AUTHZ_MAX_TTL_MS)
    return refuse('authorization_invalid', 'the authorization lives longer than 10 minutes');
  const now = (input.now ?? new Date()).getTime();
  const skew = input.skewMs ?? DEVICE_AUTHZ_SKEW_MS;
  if (now + skew < issued) return refuse('authorization_expired', 'issued in the future');
  if (now - skew > expires) return refuse('authorization_expired', 'the authorization expired');
  if (input.replay) {
    if (input.replay.has(payload.changeId))
      return refuse('replayed', 'this authorization was already used');
    input.replay.add(payload.changeId, now + DEVICE_AUTHZ_REPLAY_MS);
  }
  return { ok: true, payload };
}

/** The device's answer for a refusal (D2): 409 `conflict` for a replay, else 403. */
export function deviceAuthzError(verdict: Extract<DeviceAuthzVerdict, { ok: false }>): {
  status: number;
  code: 'conflict' | 'policy_denied';
  details: { reason: DeviceAuthzRefusal };
} {
  return verdict.reason === 'replayed'
    ? { status: 409, code: 'conflict', details: { reason: 'replayed' } }
    : { status: 403, code: 'policy_denied', details: { reason: verdict.reason } };
}
