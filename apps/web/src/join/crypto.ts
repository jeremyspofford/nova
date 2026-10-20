// The joining device's side of Add Device (FR-132, docs/22 §4.1, ADR-094), with WebCrypto only.
// The device makes an Ed25519 key whose private half cannot be exported, and runs the v2
// commit-then-reveal exchange (scratch protocol v2, review finding 1): it commits to a random
// nonce with `complete`, learns the Hub's nonce, then reveals its own; the six-digit confirmation
// covers both nonces, so a party on the path gets one guess in a million per code. With a pin
// (`fp` in the QR payload) the Hub's signature over the confirmation is checked with the Hub key
// whose SHA-256 is the pin. The rules match packages/core/src/pairing/code.ts: the same code
// reading (Crockford: O is 0, I and L are 1), the same digits (SHA-256 of the joined fields as one
// big-endian integer, mod 10^6) and the same signed messages.
import { JOIN_TEXT } from './strings.ts';

/** Crockford base32 without I, L, O and U (as the Hub makes codes). */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * The canonical code: upper case, without dashes or spaces, with Crockford's reading of the
 * look-alikes (O → 0, I and L → 1). Null when it is not a well-formed code.
 */
export function normalizePairingCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_PATTERN.test(s) ? s : null;
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function displayPairingCode(code: string): string {
  const c = normalizePairingCode(code) ?? code;
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** `123456` → `123 456`. */
export function displayConfirmation(c: string): string {
  return /^\d{6}$/.test(c) ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** `123 456`, `123456` → `123456`; null otherwise. */
export function normalizeConfirmation(input: string): string | null {
  const s = input.replace(/\s/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  // A copy in this realm's ArrayBuffer, which every WebCrypto implementation accepts.
  const out = new Uint8Array(encoded.length);
  out.set(encoded);
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  if (!s) throw new Error(JOIN_TEXT.noWebCrypto);
  return s;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', utf8(text)));
}

/** The joined fields' SHA-256 as one big-endian integer, mod 10^6, zero-padded to 6 digits. */
async function sixDigits(fields: readonly string[]): Promise<string> {
  let r = 0;
  for (const b of await sha256(fields.join('|'))) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}

/**
 * The v1 confirmation (the Relay path keeps it): `nova-add-device-v1|<hub fingerprint or ''>|
 * <pairingId>|<publicKey>|<canonical code>`.
 */
export function pairingConfirmation(input: {
  hubFingerprint: string;
  pairingId: string;
  publicKey: string;
  code: string;
}): Promise<string> {
  const canonical = normalizePairingCode(input.code) ?? input.code;
  return sixDigits([
    'nova-add-device-v1',
    input.hubFingerprint,
    input.pairingId,
    input.publicKey,
    canonical,
  ]);
}

/**
 * The v2 confirmation both screens show: `nova-add-device-v2|<hub fingerprint or ''>|<pairingId>|
 * <publicKey>|<canonical code>|<deviceNonce>|<hubNonce>`.
 */
export function pairingConfirmationV2(input: {
  hubFingerprint: string;
  pairingId: string;
  publicKey: string;
  code: string;
  deviceNonce: string;
  hubNonce: string;
}): Promise<string> {
  const canonical = normalizePairingCode(input.code) ?? input.code;
  return sixDigits([
    'nova-add-device-v2',
    input.hubFingerprint,
    input.pairingId,
    input.publicKey,
    canonical,
    input.deviceNonce,
    input.hubNonce,
  ]);
}

/** 32 random bytes, base64url: the device's nonce, kept secret until the reveal. */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** The commitment `complete` carries: base64url SHA-256 of `nova-add-device-commit-v1|<key>|<nonce>`. */
export async function commitment(publicKey: string, nonce: string): Promise<string> {
  return base64url(await sha256(`nova-add-device-commit-v1|${publicKey}|${nonce}`));
}

/** base64url SHA-256 of a raw base64url key: the Hub fingerprint a QR code pins. */
export async function keyFingerprint(publicKey: string): Promise<string> {
  return base64url(new Uint8Array(await subtle().digest('SHA-256', fromBase64url(publicKey))));
}

/** The text a device signs to poll its status: `nova-add-device-status-v1.<requestId>.<time>`. */
export function statusMessage(requestId: string, time: number): string {
  return `nova-add-device-status-v1.${requestId}.${time}`;
}

/** The text a device signs to reveal its nonce: `nova-add-device-reveal-v1.<requestId>.<time>`. */
export function revealMessage(requestId: string, time: number): string {
  return `nova-add-device-reveal-v1.${requestId}.${time}`;
}

/** What the Hub identity signs in the reveal answer. */
export function hubRevealStatement(input: {
  requestId: string;
  pairingId: string;
  publicKey: string;
  confirmation: string;
}): string {
  return [
    'nova-add-device-reveal-v1',
    input.requestId,
    input.pairingId,
    input.publicKey,
    input.confirmation,
  ].join('|');
}

/** A new Ed25519 key; the private half cannot be exported, even by this page. */
export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  return subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
}

/** The raw 32-byte public key, base64url (43 characters), as the Hub takes it. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return base64url(await subtle().exportKey('raw', key));
}

/** An Ed25519 signature of the text (base64url, 86 characters). */
export async function signText(privateKey: CryptoKey, text: string): Promise<string> {
  return base64url(await subtle().sign({ name: 'Ed25519' }, privateKey, utf8(text)));
}

/** The status poll's signature. */
export function signStatus(
  privateKey: CryptoKey,
  requestId: string,
  time: number,
): Promise<string> {
  return signText(privateKey, statusMessage(requestId, time));
}

/** The reveal's signature. */
export function signReveal(
  privateKey: CryptoKey,
  requestId: string,
  time: number,
): Promise<string> {
  return signText(privateKey, revealMessage(requestId, time));
}

/** True when `signature` (base64url) is the raw base64url key's Ed25519 signature of the text. */
export async function verifyText(
  publicKey: string,
  text: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      'raw',
      fromBase64url(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await subtle().verify({ name: 'Ed25519' }, key, fromBase64url(signature), utf8(text));
  } catch {
    return false;
  }
}
