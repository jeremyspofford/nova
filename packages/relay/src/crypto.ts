// Relay cryptography (FR-137, docs/22 §3.1, ADR-094). Primitives only from WebCrypto (X25519,
// Ed25519, HKDF-SHA256, PBKDF2-SHA256, SHA-256) and @noble/ciphers (XChaCha20-Poly1305), so the
// same code runs in Node and in browsers. Nothing here is hand-rolled.
//
// Construction:
// - Each side has an X25519 key for the Relay, separate from its Ed25519 identity key; each
//   X25519 public key travels inside the sealed pairing blobs, signed by that side's Ed25519 key.
// - Per-direction session keys: HKDF-SHA256 over the X25519 shared secret, with info binding a
//   fixed label, both routing ids, the client id, both X25519 public keys and the direction.
// - Every segment: XChaCha20-Poly1305 with a random 24-byte nonce; ct = base64(nonce || ct || tag);
//   associated data = the envelope's client, stream, seq and seg (envelope.ts).
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { NONCE_BYTES, TAG_BYTES } from './envelope.ts';
import {
  concatBytes,
  fromBase64,
  fromBase64Url,
  randomBytes,
  toBase64,
  toBase64Url,
  utf8,
} from './bytes.ts';

// WebCrypto types without the DOM lib (the package type-checks against Node's globals only).
type Subtle = typeof globalThis.crypto.subtle;
export type CryptoKey = InstanceType<typeof globalThis.CryptoKey>;
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };

const subtle = (): Subtle => globalThis.crypto.subtle;

// WebCrypto takes ArrayBuffer-backed views; copying keeps TypeScript's BufferSource happy and
// never hands WebCrypto a view into a larger shared buffer.
function buf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', buf(bytes)));
}

// ---- X25519 --------------------------------------------------------------------------------------

export interface X25519KeyPair {
  privateKey: CryptoKey;
  /** Raw 32-byte public key, base64url. */
  publicKey: string;
}

export async function generateX25519(): Promise<X25519KeyPair> {
  const pair = (await subtle().generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as unknown as KeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

/** PKCS#8 of an extractable X25519 private key, base64url (for the Hub's vault). */
export async function exportX25519Private(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().exportKey('pkcs8', key)));
}

export async function importX25519Private(pkcs8: string): Promise<X25519KeyPair> {
  const privateKey = await subtle().importKey(
    'pkcs8',
    buf(fromBase64Url(pkcs8)),
    { name: 'X25519' },
    true,
    ['deriveBits'],
  );
  const jwk = await subtle().exportKey('jwk', privateKey);
  if (!jwk.x) throw new Error('X25519 key without a public part');
  return { privateKey, publicKey: jwk.x };
}

/**
 * The private key alone, not extractable: for a side that keeps its public key elsewhere (the
 * Hub stores it with the registration), so the key never leaves WebCrypto again.
 */
export async function importX25519PrivateKey(pkcs8: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', buf(fromBase64Url(pkcs8)), { name: 'X25519' }, false, [
    'deriveBits',
  ]);
}

function rawKey(b64url: string): Uint8Array {
  const bytes = fromBase64Url(b64url);
  if (bytes.length !== 32) throw new Error('expected a 32-byte public key');
  return bytes;
}

async function x25519Shared(privateKey: CryptoKey, peerPublic: string): Promise<Uint8Array> {
  const pub = await subtle().importKey(
    'raw',
    buf(rawKey(peerPublic)),
    { name: 'X25519' },
    true,
    [],
  );
  // WebCrypto refuses low-order peer keys (an all-zero result), so no extra check is needed.
  return new Uint8Array(
    await subtle().deriveBits({ name: 'X25519', public: pub }, privateKey, 256),
  );
}

export async function hkdf(
  ikm: Uint8Array,
  info: Uint8Array,
  length = 32,
  salt = new Uint8Array(32),
): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
      key,
      length * 8,
    ),
  );
}

export interface SessionKeys {
  /** Seals what this side sends. */
  send: Uint8Array;
  /** Opens what this side receives. */
  recv: Uint8Array;
}

export interface SessionBinding {
  hubRoute: string;
  clientRoute: string;
  clientId: string;
  hubX25519: string;
  clientX25519: string;
}

/**
 * The two per-direction keys of one Hub–client pair. Both sides compute the same `h2c` and `c2h`
 * keys; the Hub sends with `h2c`, the client with `c2h`, so a frame reflected back to its sender
 * never opens.
 */
export async function deriveSessionKeys(
  side: 'hub' | 'client',
  privateKey: CryptoKey,
  b: SessionBinding,
): Promise<SessionKeys> {
  const peer = side === 'hub' ? b.clientX25519 : b.hubX25519;
  const shared = await x25519Shared(privateKey, peer);
  const info = (dir: 'h2c' | 'c2h') =>
    utf8(
      JSON.stringify([
        'nova-relay-session-v1',
        b.hubRoute,
        b.clientRoute,
        b.clientId,
        b.hubX25519,
        b.clientX25519,
        dir,
      ]),
    );
  const h2c = await hkdf(shared, info('h2c'));
  const c2h = await hkdf(shared, info('c2h'));
  shared.fill(0);
  return side === 'hub' ? { send: h2c, recv: c2h } : { send: c2h, recv: h2c };
}

// ---- XChaCha20-Poly1305 --------------------------------------------------------------------------

/** Seal to base64(nonce || ciphertext || tag). */
export function seal(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce, ad).encrypt(plaintext);
  return toBase64(concatBytes(nonce, ct));
}

/** Open a sealed segment; null when it is malformed or does not authenticate. */
export function open(key: Uint8Array, ct: string, ad: Uint8Array): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(ct);
  } catch {
    return null;
  }
  if (bytes.length < NONCE_BYTES + TAG_BYTES) return null;
  try {
    return xchacha20poly1305(key, bytes.subarray(0, NONCE_BYTES), ad).decrypt(
      bytes.subarray(NONCE_BYTES),
    );
  } catch {
    return null;
  }
}

// ---- Ed25519 -------------------------------------------------------------------------------------

export interface Ed25519Signer {
  /** Raw 32-byte public key, base64url (the device key of Add Device). */
  publicKey: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** A fresh Ed25519 identity (the private key stays inside WebCrypto, not extractable). */
export async function generateEd25519(
  extractable = false,
): Promise<Ed25519Signer & { privateKey: CryptoKey }> {
  const pair = (await subtle().generateKey({ name: 'Ed25519' }, extractable, [
    'sign',
    'verify',
  ])) as unknown as KeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey: toBase64Url(raw),
    sign: async (bytes) =>
      new Uint8Array(await subtle().sign('Ed25519', pair.privateKey, buf(bytes))),
  };
}

export async function verifyEd25519(
  publicKey: string,
  bytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      'raw',
      buf(rawKey(publicKey)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await subtle().verify('Ed25519', key, buf(signature), buf(bytes));
  } catch {
    return false;
  }
}

/** base64url(SHA-256(raw public key)): the Hub fingerprint format of FR-134. */
export async function keyFingerprint(publicKey: string): Promise<string> {
  return toBase64Url(await sha256(rawKey(publicKey)));
}

// ---- pairing secrets ----------------------------------------------------------------------------

/**
 * PBKDF2 iterations for the pairing code (OWASP's 2023 figure for PBKDF2-SHA256). The Relay holds
 * a hash of the code; a 40-bit code behind a fast hash could be brute-forced within its 5-minute
 * life, behind 600k iterations it cannot.
 */
export const PAIRING_KDF_ITERATIONS = 600_000;

export interface PairingSecrets {
  /** What the Relay stores and a claim must present (base64url, 32 bytes). */
  codeHash: string;
  /** Seals the Hub's offer (its routing id and X25519 key) for the client. */
  offerKey: Uint8Array;
  /** Seals the client's claim (its keys, name and platform) for the Hub. */
  claimKey: Uint8Array;
}

/**
 * Normalize a typed code: case-insensitive, separators dropped, and the Crockford confusables
 * O→0 and I/L→1 mapped (the code alphabet has none of O, I, L or U).
 */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Everything both sides derive from the code, salted with the Relay pairing id. */
export async function pairingSecrets(
  code: string,
  relayPairingId: string,
  iterations = PAIRING_KDF_ITERATIONS,
): Promise<PairingSecrets> {
  const base = await subtle().importKey(
    'raw',
    buf(utf8(normalizePairingCode(code))),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const master = new Uint8Array(
    await subtle().deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: buf(utf8(`nova-relay-pair-v1|${relayPairingId}`)),
        iterations,
      },
      base,
      256,
    ),
  );
  const out: PairingSecrets = {
    codeHash: toBase64Url(await hkdf(master, utf8('nova-relay-pair-v1|hash'))),
    offerKey: await hkdf(master, utf8('nova-relay-pair-v1|offer')),
    claimKey: await hkdf(master, utf8('nova-relay-pair-v1|claim')),
  };
  master.fill(0);
  return out;
}
