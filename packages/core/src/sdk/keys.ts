// Publisher keys and signatures (FR-117, FR-049; ADR-097 D1-D2). Ed25519 through node:crypto only.
// A publisher key is shown as base64url of its raw 32 bytes; the private half lives in a PKCS#8
// PEM file (`nova keys generate` writes it 0600 under the user's config folder, never in a repo).
// A signature covers a context line and a hex digest, so one kind of signature can never be
// replayed as another: `nova-extension-v1` for bundles, `nova-catalog-v1` for catalog indexes.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { NovaError } from '@nova/shared';
import { ed25519FromRaw, rawEd25519 } from '../trust/identity.ts';

/** The context line of a bundle signature (D2). */
export const EXTENSION_SIGNATURE_CONTEXT = 'nova-extension-v1\n';
/** The context line of a catalog index signature (D2; the marketplace verifies these). */
export const CATALOG_INDEX_SIGNATURE_CONTEXT = 'nova-catalog-v1\n';

const DIGEST = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export type SignatureContext =
  typeof EXTENSION_SIGNATURE_CONTEXT | typeof CATALOG_INDEX_SIGNATURE_CONTEXT;

export interface PublisherKeyPair {
  /** base64url of the raw public key. */
  publicKey: string;
  /** PKCS#8 PEM of the private key. */
  privateKeyPem: string;
}

/** A new Ed25519 publisher key pair. */
export function generatePublisherKeyPair(): PublisherKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: rawEd25519(publicKey).toString('base64url'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

/** The private key in a PEM file's text; throws `validation` when it is not an Ed25519 key. */
export function loadPublisherPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new NovaError('validation', 'the publisher key file is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new NovaError('validation', 'the publisher key must be an Ed25519 key');
  return key;
}

/** base64url of the raw public key of a private key. */
export function publisherKeyOf(privateKey: KeyObject): string {
  return rawEd25519(createPublicKey(privateKey)).toString('base64url');
}

/** Whether a string is a well-formed publisher key (and a real Ed25519 point encoding). */
export function isPublisherKey(key: string): boolean {
  if (!KEY.test(key)) return false;
  try {
    ed25519FromRaw(key);
    return true;
  } catch {
    return false;
  }
}

/** First 16 hex characters of SHA-256 over the raw key, grouped for reading aloud. */
export function publisherFingerprint(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex').slice(0, 16);
  return hex.match(/.{4}/g)!.join(':');
}

/** Sign `context + digest`; returns the signature as base64url (86 characters). */
export function signDigest(
  context: SignatureContext,
  digest: string,
  privateKey: KeyObject,
): string {
  if (!DIGEST.test(digest))
    throw new NovaError('validation', 'a digest is 64 lower-case hex digits');
  return sign(null, Buffer.from(context + digest), privateKey).toString('base64url');
}

/** Whether `signature` is the publisher's signature over `context + digest`; never throws. */
export function verifyDigest(
  context: SignatureContext,
  digest: string,
  signature: string,
  publisherKey: string,
): boolean {
  if (!DIGEST.test(digest) || !SIGNATURE.test(signature) || !KEY.test(publisherKey)) return false;
  try {
    return verify(
      null,
      Buffer.from(context + digest),
      ed25519FromRaw(publisherKey),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
