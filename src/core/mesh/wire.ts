// What the hub and its devices say to each other, and how each side proves it: pairing codes and the
// commit-then-reveal confirmation (ported from Era 1, 6e2cf142 packages/core/src/pairing/code.ts),
// Ed25519 keys and signatures, canonical JSON, sealed boxes (X25519 → HKDF → AES-GCM), the signed
// roster, and hybrid logical clocks (Era 1 packages/core/src/sync/hlc.ts).
//
// This file is shared with the device agent, which is shipped to other machines on its own, so it
// imports nothing but node:crypto and holds no state. Every byte string a key signs starts with its
// own label (nova-…-v1), so a signature made for one purpose can never be replayed as another.
import {
  createHash, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject,
} from 'node:crypto';

// ---- pairing codes ----------------------------------------------------------------------------

// Crockford base32 without I, L, O and U.
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;
// A code works once, for five minutes.
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
// How far a signed time may be from the hub's clock.
export const SIGNED_TIME_SKEW_S = 60;

const CODE_PATTERN = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

// A new code in its display form, `ABCD-EFGH`. 32 symbols divide 256, so `& 31` is unbiased.
export function newPairingCode(): string {
  let raw = '';
  for (const b of randomBytes(PAIRING_CODE_LENGTH)) raw += PAIRING_CODE_ALPHABET[b & 31]!;
  return displayPairingCode(raw);
}

// `ABCDEFGH` → `ABCD-EFGH`.
export function displayPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// The canonical code: upper case, without dashes or spaces, with Crockford's reading of the
// look-alikes (O → 0, I and L → 1). Null when it is not a well-formed code.
export function normalizePairingCode(input: string): string | null {
  const s = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_PATTERN.test(s) ? s : null;
}

// What the hub stores instead of the code: hex SHA-256 of
// `nova-add-device-code-v1|<pairingId>|<canonical code>`. Salted with the pairing id, so a hash
// says nothing about another pairing's code.
export function pairingCodeHash(pairingId: string, code: string): string {
  const canonical = normalizePairingCode(code) ?? code;
  return createHash('sha256').update(`nova-add-device-code-v1|${pairingId}|${canonical}`, 'utf8').digest('hex');
}

// Constant-time comparison of two digests (false for different lengths).
export function sameDigest(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const sixDigits = (digest: Buffer) => {
  let r = 0;
  for (const b of digest) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
};

// Era 1's first confirmation, kept for its fixed vectors; enrollment uses V2.
export function pairingConfirmation(input: { hubFingerprint: string; pairingId: string; publicKey: string; code: string }): string {
  const canonical = normalizePairingCode(input.code) ?? input.code;
  return sixDigits(createHash('sha256').update(['nova-add-device-v1', input.hubFingerprint, input.pairingId, input.publicKey, canonical].join('|'), 'utf8').digest());
}

// 32 random bytes, base64url: a nonce for either side.
export function newPairingNonce(): string {
  return randomBytes(32).toString('base64url');
}

// The device commits to its nonce before it learns the hub's: base64url SHA-256 of
// `nova-add-device-commit-v1|<publicKey>|<nonce>`. Someone on the path who sees the code and the
// key then can't grind a key that gives the same digits.
export function pairingCommitment(publicKey: string, nonce: string): string {
  return createHash('sha256').update(`nova-add-device-commit-v1|${publicKey}|${nonce}`, 'utf8').digest('base64url');
}

// The six digits both screens show: SHA-256 of `nova-add-device-v2|<hub fingerprint>|<pairingId>|
// <publicKey>|<canonical code>|<deviceNonce>|<hubNonce>`, as a big-endian integer mod 10^6.
export function pairingConfirmationV2(input: { hubFingerprint: string; pairingId: string; publicKey: string; code: string; deviceNonce: string; hubNonce: string }): string {
  const canonical = normalizePairingCode(input.code) ?? input.code;
  return sixDigits(createHash('sha256').update(['nova-add-device-v2', input.hubFingerprint, input.pairingId, input.publicKey, canonical, input.deviceNonce, input.hubNonce].join('|'), 'utf8').digest());
}

// `123456` or `123 456` → `123456`; null otherwise.
export function normalizeConfirmation(input: string): string | null {
  const s = String(input).replace(/\s/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

// ---- what a device signs -----------------------------------------------------------------------

// Polling a join request's status: `nova-add-device-status-v1.<requestId>.<time>` (Unix seconds).
export function statusMessage(requestId: string, time: number): Buffer {
  return Buffer.from(`nova-add-device-status-v1.${requestId}.${time}`, 'utf8');
}

// Revealing its nonce: `nova-add-device-reveal-v1.<requestId>.<time>`.
export function revealMessage(requestId: string, time: number): Buffer {
  return Buffer.from(`nova-add-device-reveal-v1.${requestId}.${time}`, 'utf8');
}

// Starting a session: `nova-session-v1.<deviceId>.<time>`.
export function sessionMessage(deviceId: string, time: number): Buffer {
  return Buffer.from(`nova-session-v1.${deviceId}.${time}`, 'utf8');
}

// The device's X25519 key, vouched for by its Ed25519 key in the join request.
export function x25519Statement(x25519PublicKey: string): Buffer {
  return Buffer.from(`nova-x25519-v1.${x25519PublicKey}`, 'utf8');
}

// Whether a signed time is close enough to now (both Unix seconds).
export function freshTime(time: number, nowS: number, skewS = SIGNED_TIME_SKEW_S): boolean {
  return Number.isInteger(time) && Math.abs(time - nowS) <= skewS;
}

// ---- keys --------------------------------------------------------------------------------------

// Raw 32-byte public keys (Ed25519 and X25519), base64url.
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// A raw Ed25519 signature (64 bytes), base64url.
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

function rawPublic(raw: string, crv: 'Ed25519' | 'X25519'): KeyObject | null {
  if (typeof raw !== 'string' || !PUBLIC_KEY_PATTERN.test(raw)) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv, x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

// A KeyObject for a raw base64url Ed25519 public key, or null when it is not one.
export const ed25519PublicKey = (raw: string): KeyObject | null => rawPublic(raw, 'Ed25519');
// The same for X25519.
export const x25519PublicKey = (raw: string): KeyObject | null => rawPublic(raw, 'X25519');

// The raw base64url public key of a key object (public or private).
export function publicKeyOf(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return (pub.export({ format: 'jwk' }) as { x: string }).x;
}

export interface KeyPair { publicKey: string; privateKey: KeyObject }
export interface DeviceKeys { ed25519: KeyPair; x25519: KeyPair }
// What a key file holds: the raw private scalars, base64url. Only the hub's identity file and a
// device's boot key file (both mode 0600) ever contain this.
export interface DeviceKeysJson { ed25519: { public: string; private: string }; x25519: { public: string; private: string } }

const pairOf = (kind: 'ed25519' | 'x25519'): KeyPair => {
  const { privateKey } = generateKeyPairSync(kind as 'ed25519');
  return { publicKey: publicKeyOf(privateKey), privateKey };
};

// A new identity: an Ed25519 key for signing and an X25519 key for sealing.
export function generateDeviceKeys(): DeviceKeys {
  return { ed25519: pairOf('ed25519'), x25519: pairOf('x25519') };
}

export function exportDeviceKeys(k: DeviceKeys): DeviceKeysJson {
  const d = (p: KeyPair) => ({ public: p.publicKey, private: (p.privateKey.export({ format: 'jwk' }) as { d: string }).d });
  return { ed25519: d(k.ed25519), x25519: d(k.x25519) };
}

// Reads a key file's contents back; throws if it is malformed or a public key doesn't match.
export function importDeviceKeys(j: DeviceKeysJson): DeviceKeys {
  const one = (p: { public: string; private: string } | undefined, crv: 'Ed25519' | 'X25519'): KeyPair => {
    if (!p || !PUBLIC_KEY_PATTERN.test(p.public) || !PUBLIC_KEY_PATTERN.test(p.private)) throw new Error(`The ${crv} key is malformed.`);
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: { kty: 'OKP', crv, x: p.public, d: p.private }, format: 'jwk' });
    } catch {
      privateKey = null as unknown as KeyObject;
    }
    if (!privateKey || publicKeyOf(privateKey) !== p.public) throw new Error(`The ${crv} key doesn't match its public half.`);
    return { publicKey: p.public, privateKey };
  };
  return { ed25519: one(j?.ed25519, 'Ed25519'), x25519: one(j?.x25519, 'X25519') };
}

// An Ed25519 signature of `message`, base64url.
export function signMessage(privateKey: KeyObject, message: Uint8Array): string {
  return edSign(null, message, privateKey).toString('base64url');
}

// True when `signature` (base64url) is the raw base64url key's Ed25519 signature of `message`.
export function verifyDeviceSignature(publicKey: string, message: Uint8Array, signature: string): boolean {
  const key = ed25519PublicKey(publicKey);
  if (!key || typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) return false;
  try {
    return edVerify(null, message, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// What a person compares: the first 20 bytes of SHA-256 of the raw Ed25519 public key, in
// Crockford base32, in groups of four (`ABCD-EFGH-…`, eight groups).
export function keyFingerprint(publicKey: string): string {
  const bytes = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest().subarray(0, 20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += PAIRING_CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join('-');
}

// ---- canonical JSON ---------------------------------------------------------------------------

// JSON with object keys sorted at every level and no whitespace, so signer and verifier hash the
// same bytes. Arrays keep their order; undefined members are left out. Non-finite numbers and
// non-JSON values are refused.
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
  }
}

// ---- sealed boxes ----------------------------------------------------------------------------

// Static-static X25519 between two mesh members, a fresh HKDF salt per message (so no key is
// used twice), AES-256-GCM. Both public keys are bound into the key, so a box opens only for the
// pair it was sealed between. Layout: version (1) | salt (16) | iv (12) | ciphertext | tag (16).
const SEAL_VERSION = 1;
const SEAL_INFO = 'nova-seal-v1';

function sealKey(shared: Buffer, salt: Buffer, fromPub: string, toPub: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(`${SEAL_INFO}|${fromPub}|${toPub}`, 'utf8'), 32));
}

// Seals `bytes` from the holder of `fromX25519Priv` to the holder of `toX25519Pub`. `aad`, when
// given, must be given again to open it.
export function seal(toX25519Pub: string, fromX25519Priv: KeyObject, bytes: Uint8Array, aad?: Uint8Array): Buffer {
  const to = x25519PublicKey(toX25519Pub);
  if (!to) throw new TypeError('seal: not an X25519 public key');
  const shared = diffieHellman({ privateKey: fromX25519Priv, publicKey: to });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(shared, salt, publicKeyOf(fromX25519Priv), toX25519Pub), iv);
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), salt, iv, body, cipher.getAuthTag()]);
}

// Opens a box sealed by the holder of `fromX25519Pub` to the holder of `toX25519Priv`. Throws if
// it was tampered with, sealed for someone else, or isn't a box.
export function open(fromX25519Pub: string, toX25519Priv: KeyObject, sealed: Uint8Array, aad?: Uint8Array): Buffer {
  const from = x25519PublicKey(fromX25519Pub);
  if (!from) throw new TypeError('open: not an X25519 public key');
  const box = Buffer.from(sealed);
  if (box.length < 1 + 16 + 12 + 16 || box[0] !== SEAL_VERSION) throw new Error('open: not a sealed box');
  const salt = box.subarray(1, 17);
  const iv = box.subarray(17, 29);
  const tag = box.subarray(box.length - 16);
  const shared = diffieHellman({ privateKey: toX25519Priv, publicKey: from });
  const decipher = createDecipheriv('aes-256-gcm', sealKey(shared, salt, fromX25519Pub, publicKeyOf(toX25519Priv)), iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(box.subarray(29, box.length - 16)), decipher.final()]);
}

// ---- the roster -------------------------------------------------------------------------------

// Who the hub and the standby are, signed by the node that is hub. Devices pin the keys of both
// and accept a roster only when one of the pinned keys signed it, with an epoch at least the one
// they know (a lower epoch is never accepted: that is how a demoted hub is fenced off).
export interface RosterMember { id: string; url: string | null; public_key: string; x25519_public_key: string }
export interface Roster { epoch: number; hub: RosterMember; standby?: RosterMember; issued_at: string }
export interface SignedRoster { roster: Roster; signature: string }

export function rosterMessage(roster: Roster): Buffer {
  return Buffer.from(`nova-roster-v1.${canonicalJson(roster)}`, 'utf8');
}

export function signRoster(roster: Roster, privateKey: KeyObject): SignedRoster {
  return { roster, signature: signMessage(privateKey, rosterMessage(roster)) };
}

// True when one of `pinned` (raw Ed25519 public keys) signed it.
export function verifyRoster(signed: SignedRoster, pinned: string[]): boolean {
  if (!signed || typeof signed !== 'object' || !signed.roster) return false;
  let message: Buffer;
  try {
    message = rosterMessage(signed.roster);
  } catch {
    return false;
  }
  return pinned.some((k) => verifyDeviceSignature(k, message, signed.signature));
}

// ---- what a node proves to a device agent (M4b) ---------------------------------------------------

// A node answering a device's challenge: `nova-hello-v1.<challenge>.<canonical JSON of what it
// claims>`. A device signs a session request only for a node that proved it holds a pinned key, so
// a stranger at the hub's address never gets a usable signature.
export interface HelloClaim { id: string; role: string; epoch: number; public_key: string }
export function helloProofMessage(challenge: string, claim: HelloClaim): Buffer {
  return Buffer.from(`nova-hello-v1.${challenge}.${canonicalJson(claim)}`, 'utf8');
}

// The runtime agent a hub ships: each file's SHA-256 (hex), the SHA-256 of the canonical JSON of
// that map, and a version. The hub signs `nova-runtime-v1.<canonical JSON of the manifest>`; the
// boot agent checks the signature against its pinned keys and every file against its hash before
// anything replaces the runtime it has.
// `epoch` and `issued_at` (both signed with the rest) order bundles, so a device never goes back
// to an older runtime, however validly signed: a higher epoch wins, then the later signing time.
export interface RuntimeManifest { version: string; sha256: string; files: Record<string, string>; epoch?: number; issued_at?: string }
export function runtimeManifestMessage(m: RuntimeManifest): Buffer {
  return Buffer.from(`nova-runtime-v1.${canonicalJson(m)}`, 'utf8');
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// The manifest for a set of files (name → contents).
export function runtimeManifest(version: string, files: Record<string, Uint8Array>): RuntimeManifest {
  const hashes: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) hashes[name] = sha256Hex(files[name]!);
  return { version, sha256: sha256Hex(canonicalJson(hashes)), files: hashes };
}

// ---- hybrid logical clocks --------------------------------------------------------------------

// A value is physical milliseconds, a logical counter and the node that issued it, written with
// fixed widths so plain string order is clock order (the node breaks ties). A clock only moves
// forward: it starts from the last value it persisted, takes the larger of its wall clock and
// every clock it has seen, and counts up within one millisecond.
export const HLC_PATTERN = /^(\d{15})-([0-9a-f]{4})-([A-Za-z0-9._:-]{1,100})$/;

export interface Hlc { pt: number; c: number; node: string }

// The largest counter; one more moves the physical part ahead by a millisecond.
export const HLC_MAX_COUNTER = 0xffff;
const MAX_PT = 999_999_999_999_999;

export function formatHlc(h: Hlc): string {
  return `${String(h.pt).padStart(15, '0')}-${h.c.toString(16).padStart(4, '0')}-${h.node}`;
}

export function parseHlc(value: string): Hlc | null {
  const m = HLC_PATTERN.exec(value);
  if (!m) return null;
  return { pt: Number(m[1]), c: parseInt(m[2] ?? '0', 16), node: m[3] ?? '' };
}

// Negative when `a` is older than `b`; an empty string is older than every clock.
export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

export interface HybridClockOptions { node: string; now?: () => number; initial?: string | null }

export class HybridClock {
  readonly node: string;
  readonly #now: () => number;
  #pt = 0;
  #c = 0;

  constructor(opts: HybridClockOptions) {
    this.node = opts.node;
    this.#now = opts.now ?? Date.now;
    const start = opts.initial ? parseHlc(opts.initial) : null;
    if (start) {
      this.#pt = start.pt;
      this.#c = start.c;
    }
  }

  // The last value issued (or the start), without moving the clock.
  last(): string {
    return formatHlc({ pt: this.#pt, c: this.#c, node: this.node });
  }

  // A new value for a local change: later than every value issued or seen.
  tick(): string {
    const wall = this.#wall();
    if (wall > this.#pt) {
      this.#pt = wall;
      this.#c = 0;
    } else this.#bump(this.#c + 1);
    return this.last();
  }

  // Takes in another node's clock: the next local value is later than it.
  receive(remote: string): string {
    const r = parseHlc(remote);
    if (!r) return this.last();
    const wall = this.#wall();
    const pt = Math.max(this.#pt, r.pt, wall);
    if (pt === this.#pt && pt === r.pt) this.#bump(Math.max(this.#c, r.c) + 1);
    else if (pt === this.#pt) this.#bump(this.#c + 1);
    else if (pt === r.pt) {
      this.#pt = pt;
      this.#bump(r.c + 1);
    } else {
      this.#pt = pt;
      this.#c = 0;
    }
    return this.last();
  }

  #wall(): number {
    return Math.min(MAX_PT, Math.max(0, Math.floor(this.#now())));
  }

  #bump(c: number): void {
    if (c > HLC_MAX_COUNTER) {
      this.#pt += 1;
      this.#c = 0;
    } else this.#c = c;
  }
}

// Why a pushed clock is refused, or null when it is usable: it must parse, name the pushing node
// (no device can tie-break as another), and be at most `maxSkewMs` ahead of the receiver's wall
// clock, so a node whose clock runs far ahead can't win every merge.
export function hlcProblem(value: string, opts: { node: string; nowMs: number; maxSkewMs: number }): 'invalid_hlc' | 'hlc_device_mismatch' | 'clock_skew' | null {
  const h = parseHlc(value);
  if (!h) return 'invalid_hlc';
  if (h.node !== opts.node) return 'hlc_device_mismatch';
  if (h.pt > opts.nowMs + opts.maxSkewMs) return 'clock_skew';
  return null;
}
