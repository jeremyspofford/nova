// Add Device codes and proofs (FR-132, docs/22 §4.1, ADR-094). The pairing code is 8 characters of
// Crockford base32 (40 bits), single use and short-lived; the Hub keeps only a hash salted with the
// pairing id. The confirmation is 6 digits both screens show. In v2 (direct joins) each side
// commits before it learns the other's random nonce: the device sends a commitment to its nonce
// with `complete`, the Hub answers with its own nonce, then the device reveals; so someone on the
// path who sees the code and the key cannot grind a key that gives the same digits (review
// finding 1). The Relay path keeps v1. The status poll and the reveal are signed by the device key
// over the request id and a fresh time. Only node:crypto primitives are used.
import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { ed25519PublicKey } from '../nodes/crypto.ts';

/** Crockford base32 without I, L, O and U. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

const CODE_PATTERN = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/** A new code in its display form, `ABCD-EFGH`. 32 symbols divide 256, so `& 31` is unbiased. */
export function newPairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let raw = '';
  for (const b of bytes) raw += PAIRING_CODE_ALPHABET[b & 31]!;
  return displayPairingCode(raw);
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function displayPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The canonical code: upper case, without dashes or spaces, with Crockford's reading of the
 * look-alikes (O → 0, I and L → 1). Null when it is not a well-formed code.
 */
export function normalizePairingCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_PATTERN.test(s) ? s : null;
}

/**
 * What the Hub stores, and what a Relay claim presents as `codeHashCheck`: hex SHA-256 of
 * `nova-add-device-code-v1|<pairingId>|<canonical code>`. Salted with the pairing id, so a hash
 * says nothing about another pairing's code.
 */
export function pairingCodeHash(pairingId: string, code: string): string {
  const canonical = normalizePairingCode(code) ?? code;
  return createHash('sha256')
    .update(`nova-add-device-code-v1|${pairingId}|${canonical}`, 'utf8')
    .digest('hex');
}

/** Constant-time comparison of two hex digests (false for different lengths). */
export function sameDigest(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The confirmation code (docs/22 §4.1 step 2): SHA-256 of
 * `nova-add-device-v1|<hub fingerprint or ''>|<pairingId>|<publicKey>|<canonical code>` (UTF-8),
 * read as one big-endian unsigned integer, mod 10^6, zero-padded to 6 digits.
 */
export function pairingConfirmation(input: {
  hubFingerprint: string;
  pairingId: string;
  publicKey: string;
  code: string;
}): string {
  const canonical = normalizePairingCode(input.code) ?? input.code;
  const digest = createHash('sha256')
    .update(
      [
        'nova-add-device-v1',
        input.hubFingerprint,
        input.pairingId,
        input.publicKey,
        canonical,
      ].join('|'),
      'utf8',
    )
    .digest();
  let r = 0;
  for (const b of digest) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}

/** 32 random bytes, base64url: the Hub's nonce in v2. */
export function newPairingNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** The device's v2 commitment: base64url SHA-256 of `nova-add-device-commit-v1|<publicKey>|<nonce>`. */
export function pairingCommitment(publicKey: string, nonce: string): string {
  return createHash('sha256')
    .update(`nova-add-device-commit-v1|${publicKey}|${nonce}`, 'utf8')
    .digest('base64url');
}

/**
 * The v2 confirmation: SHA-256 of `nova-add-device-v2|<hub fingerprint or ''>|<pairingId>|
 * <publicKey>|<canonical code>|<deviceNonce>|<hubNonce>` (UTF-8), read as a big-endian unsigned
 * integer, mod 10^6, zero-padded to 6 digits.
 */
export function pairingConfirmationV2(input: {
  hubFingerprint: string;
  pairingId: string;
  publicKey: string;
  code: string;
  deviceNonce: string;
  hubNonce: string;
}): string {
  const canonical = normalizePairingCode(input.code) ?? input.code;
  const digest = createHash('sha256')
    .update(
      [
        'nova-add-device-v2',
        input.hubFingerprint,
        input.pairingId,
        input.publicKey,
        canonical,
        input.deviceNonce,
        input.hubNonce,
      ].join('|'),
      'utf8',
    )
    .digest();
  let r = 0;
  for (const b of digest) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}

/**
 * What the Hub identity signs in the reveal answer:
 * `nova-add-device-reveal-v1|<requestId>|<pairingId>|<publicKey>|<confirmation>`. A device with a
 * pin checks it against the pinned key, and that the signed key is its own.
 */
export function hubRevealStatement(input: {
  requestId: string;
  pairingId: string;
  publicKey: string;
  confirmation: string;
}): Buffer {
  return Buffer.from(
    [
      'nova-add-device-reveal-v1',
      input.requestId,
      input.pairingId,
      input.publicKey,
      input.confirmation,
    ].join('|'),
    'utf8',
  );
}

/** `123456` or `123 456` → `123456`; null otherwise. */
export function normalizeConfirmation(input: string): string | null {
  const s = input.replace(/\s/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

/** The bytes a device signs to poll its status: `nova-add-device-status-v1.<requestId>.<time>`. */
export function statusMessage(requestId: string, time: number): Buffer {
  return Buffer.from(`nova-add-device-status-v1.${requestId}.${time}`, 'utf8');
}

/** The bytes a device signs to reveal its nonce: `nova-add-device-reveal-v1.<requestId>.<time>`. */
export function revealMessage(requestId: string, time: number): Buffer {
  return Buffer.from(`nova-add-device-reveal-v1.${requestId}.${time}`, 'utf8');
}

/** True when `signature` (base64url) is the raw base64url key's Ed25519 signature of `message`. */
export function verifyDeviceSignature(
  publicKey: string,
  message: Buffer,
  signature: string,
): boolean {
  const key = ed25519PublicKey(publicKey);
  if (!key || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return verify(null, message, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** True when `signature` (base64url) is the key's Ed25519 signature of the status message. */
export function verifyStatusSignature(
  publicKey: string,
  requestId: string,
  time: number,
  signature: string,
): boolean {
  return verifyDeviceSignature(publicKey, statusMessage(requestId, time), signature);
}

/** True when `signature` (base64url) is the key's Ed25519 signature of the reveal message. */
export function verifyRevealSignature(
  publicKey: string,
  requestId: string,
  time: number,
  signature: string,
): boolean {
  return verifyDeviceSignature(publicKey, revealMessage(requestId, time), signature);
}
