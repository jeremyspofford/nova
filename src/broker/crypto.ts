// The broker's cryptography, on node:crypto alone (no dependency; ADR-2 exception, Conflicts row 3).
//  - AES-256-GCM with associated data for every blob, so nothing can be swapped between files.
//  - Argon2id (crypto.argon2, Node 26) for the passphrase, RFC 9106's second recommended setting as
//    the floor (m = 64 MiB, t = 3, p = 4), raised by a timed calibration at setup.
//  - Every unlock factor is an X25519 key pair: the passphrase's private key is its Argon2id output,
//    a recovery key's and a passkey PRF output's come through HKDF, and a device's is random and
//    kept in that device's key store. The root key is sealed to each factor's public key, so the
//    broker can re-seal a new root key (a delete, a holder removed) without asking for any factor.
//  - Sealed entry (§10): the person's client seals a value with ECDH P-256 to the broker's per-boot
//    entry key, then HKDF and AES-GCM, bound to the pending action's digest.
import { argon2Sync, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export interface Sealed { n: string; c: string; t: string }
const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: unknown, what: string): Buffer => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/=_-]*$/.test(s)) throw new Error(`${what} isn’t base64`);
  return Buffer.from(s, 'base64');
};
export { b64, unb64 };

export function seal(key: Buffer, plain: Buffer, aad: string): Sealed {
  const n = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, n);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { n: b64(n), c: b64(ct), t: b64(c.getAuthTag()) };
}

// Wrong key, a tampered blob or a blob moved to another place: refused, never guessed at.
export function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, unb64(s?.n, 'nonce'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(unb64(s?.t, 'tag'));
  return Buffer.concat([d.update(unb64(s?.c, 'ciphertext')), d.final()]);
}

// ---- Argon2id -----------------------------------------------------------------------------------

export interface Kdf { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
export const KDF_FLOOR = { m: 65536, t: 3, p: 4 } as const;

export function argon2id(secret: Buffer, k: Kdf): Buffer {
  if (k.alg !== 'argon2id' || k.m < KDF_FLOOR.m || k.t < KDF_FLOOR.t || k.p < KDF_FLOOR.p) throw new Error('Argon2id parameters below the floor (m = 64 MiB, t = 3, p = 4)');
  return argon2Sync('argon2id', { message: secret, nonce: unb64(k.salt, 'salt'), memory: k.m, passes: k.t, parallelism: k.p, tagLength: 32 });
}

// The floor, raised while a derivation takes under half the target, up to 1 GiB.
export function calibrate(targetMs = 500, maxM = 1 << 20): Kdf {
  const k: Kdf = { alg: 'argon2id', ...KDF_FLOOR, salt: b64(randomBytes(16)) };
  for (;;) {
    const t0 = performance.now();
    argon2id(Buffer.from('calibrate'), k);
    if (performance.now() - t0 >= targetMs / 2 || k.m * 2 > maxM) return k;
    k.m *= 2;
  }
}

// ---- X25519 factors -----------------------------------------------------------------------------

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export interface Factor { priv: KeyObject; pub: string }
export function factorFromSeed(seed: Buffer): Factor {
  if (seed.length !== 32) throw new Error('a factor seed is 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { priv, pub: rawPub(priv) };
}
export function newFactor(): { seed: Buffer; factor: Factor } {
  const seed = randomBytes(32);
  return { seed, factor: factorFromSeed(seed) };
}
const rawPub = (priv: KeyObject) => b64((createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
const pubKey = (raw: string) => {
  const r = unb64(raw, 'public key');
  if (r.length !== 32) throw new Error('an X25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([X25519_SPKI, r]), format: 'der', type: 'spki' });
};
export const hkdf = (ikm: Buffer, salt: Buffer | string, info: string, n = 32) => Buffer.from(hkdfSync('sha256', ikm, salt, info, n));

// The root key sealed to a factor's public key, for the wrap named `info`.
export interface Wrap { pub: string; eph: string; box: Sealed }
export function sealTo(pub: string, plain: Buffer, info: string): Wrap {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const eph = b64((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
  const k = hkdf(diffieHellman({ privateKey, publicKey: pubKey(pub) }), `${eph}|${pub}`, info);
  return { pub, eph, box: seal(k, plain, info) };
}
export function openWrap(f: Factor, w: Wrap, info: string): Buffer {
  if (w.pub !== f.pub) throw new Error('that factor doesn’t open this wrap');
  const k = hkdf(diffieHellman({ privateKey: f.priv, publicKey: pubKey(w.eph) }), `${w.eph}|${w.pub}`, info);
  return open(k, w.box, info);
}

// ---- Ed25519: a holder's broker signs the header it sends (so a holder adopts only its hub's) -----

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export function signerFromSeed(seed: Buffer): { priv: KeyObject; pub: string } {
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { priv, pub: b64((createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)) };
}
export const signText = (priv: KeyObject, text: string) => b64(sign(null, Buffer.from(text, 'utf8'), priv));
export function verifyText(pub: string, text: string, sig: unknown): boolean {
  try {
    const raw = unb64(pub, 'signer');
    if (raw.length !== 32) return false;
    return verify(null, Buffer.from(text, 'utf8'), createPublicKey({ key: Buffer.concat([ED_SPKI, raw]), format: 'der', type: 'spki' }), unb64(sig, 'signature'));
  } catch { return false; }
}

// ---- sealed entry (P-256, matching WebCrypto in the person's client: src/broker/seal.ts) ---------

export interface Envelope { epk: string; iv: string; ct: string }
export function entryKey(): { priv: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { priv: privateKey, pub: b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])) };
}
export function openEnvelope(priv: KeyObject, e: Envelope, digest: string): Buffer {
  if (!e || typeof e !== 'object') throw new Error('not a sealed value');
  const raw = unb64(e.epk, 'epk');
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not a P-256 point');
  const epk = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  const k = hkdf(diffieHellman({ privateKey: priv, publicKey: epk }), Buffer.from(digest, 'hex'), 'nova-broker-entry-v1');
  const ct = unb64(e.ct, 'ct');
  if (ct.length < 17) throw new Error('sealed value cut short');
  const d = createDecipheriv('aes-256-gcm', k, unb64(e.iv, 'iv'));
  d.setAAD(Buffer.from(digest, 'utf8'));
  d.setAuthTag(ct.subarray(-16));
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
}
