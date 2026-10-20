// Catalog signatures and artifact checksums (FR-049; docs/08 §7; ADR-097 D2). A catalog index is
// signed with Ed25519 over `"nova-catalog-v1\n" + <hex SHA-256 of the index bytes>` (the SDK's
// signing helpers, so a catalog signature can never pass for a bundle's); the signature file sits
// next to the index (`<index>.sig`) and reads `{v: 1, publisher, digest, signature}` like a
// bundle's `META-INF/nova-signature.json`. A folder artifact's checksum is the D2 digest over its
// files, as for a bundle. Keys travel as base64url of the raw 32-byte public key.
import { createHash, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { NovaError, type MarketCatalogSignature, type MarketPublisher } from '@nova/shared';
import { walkTree, type TreeEntry } from '../plugins/paths.ts';
import { extensionDigest } from '../sdk/bundle.ts';
import {
  CATALOG_INDEX_SIGNATURE_CONTEXT,
  publisherFingerprint,
  publisherKeyOf,
  signDigest,
  verifyDigest,
} from '../sdk/keys.ts';

/** The signature file's name next to an index: `catalog.json.sig`, `nova-catalog.json.sig`. */
export const CATALOG_SIGNATURE_SUFFIX = '.sig';

export const publisherKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'expected base64url of a raw 32-byte Ed25519 public key');

const signatureFileSchema = z.object({
  v: z.literal(1),
  publisher: publisherKeySchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type CatalogSignatureFile = z.infer<typeof signatureFileSchema>;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The D2 digest of a folder (links that leave it and oversized trees are refused). A file name
 * with a control character is refused, as in a bundle: a newline could merge lines of the listing,
 * so one digest could stand for another set of files.
 */
export function folderDigest(root: string, entries?: readonly TreeEntry[]): string {
  const list = entries ?? walkTree(root);
  // eslint-disable-next-line no-control-regex
  const bad = list.find((e) => /[\u0000-\u001f\u007f]/.test(e.path));
  if (bad)
    throw new NovaError(
      'validation',
      `a file name in the item contains a control character: ${JSON.stringify(bad.path.slice(0, 200))}`,
    );
  // One file in memory at a time.
  return extensionDigest(
    (function* () {
      for (const e of list) yield [e.path, readFileSync(e.source)] as const;
    })(),
  );
}

/** The signature file for an index (`nova-catalog-v1`), as JSON text. */
export function signCatalogIndex(index: Uint8Array | string, privateKey: KeyObject): string {
  const digest = sha256Hex(index);
  const file: CatalogSignatureFile = {
    v: 1,
    publisher: publisherKeyOf(privateKey),
    digest,
    signature: signDigest(CATALOG_INDEX_SIGNATURE_CONTEXT, digest, privateKey),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export interface TrustedPublisherKey {
  name: string | null;
  key: string;
}

/**
 * A publisher as shown: named only when the owner trusts the key (the trusted publishers, or the
 * key a catalog pins), always with its fingerprint.
 */
export function publisherView(
  key: string,
  trusted: readonly TrustedPublisherKey[],
  pinned = false,
): MarketPublisher {
  const named = trusted.find((t) => t.key === key);
  return {
    name: named?.name ?? null,
    key,
    fingerprint: publisherFingerprint(key),
    trusted: named !== undefined || pinned,
  };
}

export interface CatalogSignatureCheck {
  status: MarketCatalogSignature;
  publisher: MarketPublisher | null;
  /** Why it is not verified, in plain words. */
  reason: string | null;
}

/**
 * Check an index against its signature file. `pinned`: the key the catalog entry pins (only it
 * verifies, and a signature by any other key is `invalid`); otherwise any trusted key verifies
 * and a good signature by an unknown key is `untrusted`.
 */
export function verifyCatalogIndex(
  index: Uint8Array,
  signatureFile: Uint8Array | null,
  opts: { pinned?: string | null; trusted: readonly TrustedPublisherKey[] },
): CatalogSignatureCheck {
  if (!signatureFile)
    // A catalog that pins a key is always signed: a missing signature is a downgrade, refused.
    return opts.pinned
      ? {
          status: 'invalid',
          publisher: null,
          reason: 'this catalog pins a publisher key, but its index is not signed',
        }
      : { status: 'unsigned', publisher: null, reason: 'the index is not signed' };
  let parsed: CatalogSignatureFile;
  try {
    const r = signatureFileSchema.safeParse(
      JSON.parse(Buffer.from(signatureFile).toString('utf8')),
    );
    if (!r.success) throw new Error('shape');
    parsed = r.data;
  } catch {
    return { status: 'invalid', publisher: null, reason: 'the signature file is damaged' };
  }
  const named = opts.trusted.find((t) => t.key === parsed.publisher);
  const publisher = publisherView(
    parsed.publisher,
    opts.trusted,
    !!opts.pinned && opts.pinned === parsed.publisher,
  );
  if (parsed.digest !== sha256Hex(index))
    return { status: 'invalid', publisher, reason: 'the index does not match its signature' };
  if (
    !verifyDigest(
      CATALOG_INDEX_SIGNATURE_CONTEXT,
      parsed.digest,
      parsed.signature,
      parsed.publisher,
    )
  )
    return { status: 'invalid', publisher, reason: 'the signature does not verify' };
  if (opts.pinned) {
    if (opts.pinned !== parsed.publisher)
      return {
        status: 'invalid',
        publisher,
        reason: 'the index is signed by another key than the one this catalog pins',
      };
    return { status: 'verified', publisher, reason: null };
  }
  if (named) return { status: 'verified', publisher, reason: null };
  return {
    status: 'untrusted',
    publisher,
    reason: 'the index is signed by a key that is not in your trusted publishers',
  };
}
