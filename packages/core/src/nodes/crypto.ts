// Capability-document signatures (FR-126, contracts/hub-api.md §2, ADR-089). A compute node signs
// the canonical JSON of its capability document with an Ed25519 key; the Hub pins the public key
// at registration and verifies every document the node sends afterwards against it.
// The node side (services/compute) implements the same canonical form; both are tested together.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/** Raw Ed25519 public key, base64url (32 bytes). */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Raw Ed25519 signature, base64url (64 bytes). */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

/**
 * JSON with object keys sorted at every level and no whitespace, so signer and verifier hash the
 * same bytes. Arrays keep their order. Non-finite numbers and non-JSON values are refused.
 */
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

/** A KeyObject for a raw base64url Ed25519 public key, or null when it is not one. */
export function ed25519PublicKey(raw: string): KeyObject | null {
  if (!PUBLIC_KEY_PATTERN.test(raw)) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

/** True when `signature` is the key's Ed25519 signature over the document's canonical JSON. */
export function verifyDocument(document: unknown, signature: string, publicKey: string): boolean {
  const key = ed25519PublicKey(publicKey);
  if (!key || !SIGNATURE_PATTERN.test(signature)) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(canonicalJson(document), 'utf8');
  } catch {
    return false;
  }
  try {
    return verify(null, bytes, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * The device fingerprint until certificates exist (M6.5): SHA-256 of the raw public key, hex.
 * `device.cert_fingerprint` is unique, so a key can register once; a revoked key stays burned.
 */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
}

/**
 * Hash of a node credential (`nvn_…`) or enrollment token (`nve_…`) for storage. Domain-separated
 * from session token hashes, so a node credential presented to the user API can never match a
 * session lookup (it authenticates nothing there), and the reverse.
 */
export function nodeSecretHash(token: string): string {
  return createHash('sha256').update('nova-node\0').update(token, 'utf8').digest('hex');
}
