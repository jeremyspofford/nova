// The node's identity (FR-126, ADR-089): an Ed25519 key pair that signs its capability document,
// and the random job token the Hub must present on every job call. The canonical JSON form must
// match the Hub's verifier (packages/core/src/nodes/crypto.ts); a cross-test enforces it.
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from 'node:crypto';

export interface NodeKeys {
  /** PKCS#8 PEM; kept only in the 0600 state file. */
  privateKeyPem: string;
  /** Raw public key, base64url (32 bytes). */
  publicKey: string;
}

export function generateKeys(): NodeKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('could not export the public key');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: jwk.x,
  };
}

/** A 256-bit random job token (docs/12 §15). */
export function newJobToken(): string {
  return `nvj_${randomBytes(32).toString('base64url')}`;
}

/** A stable random device id for the capability document. */
export function newDeviceId(): string {
  return randomBytes(16).toString('hex');
}

/** Sorted-key, whitespace-free JSON: the bytes that are signed. */
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
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
  }
}

/** Ed25519 signature over the document's canonical JSON, base64url. */
export function signDocument(document: unknown, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(canonicalJson(document), 'utf8'), key).toString('base64url');
}

/** Constant-time token comparison that does not leak the length (docs/12 §15). */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && presented.length === expected.length;
}
