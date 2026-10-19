// `.novax` extension bundles (FR-117; ADR-097 D2): a zip of the plugin folder (the M4 plugin
// format plus `.nova-plugin/extension.json`) and `META-INF/nova-signature.json`
// `{v: 1, publisher, digest, signature}`. `digest` is the hex SHA-256 over the sorted lines
// `"<path>\n<sha256 of its bytes>\n"` of every other entry, and `signature` is Ed25519 over
// `"nova-extension-v1\n" + digest` by `publisher` (base64url of the raw key).
//
// Reading never runs anything: entry names are checked against path traversal, sizes and the
// entry count are capped before anything is inflated (documents/zip.ts), and a bundle whose
// signature does not match its contents is refused outright, sideload or not. A good signature
// by a key the owner does not trust, or no signature at all, is Unverified: it installs only
// through the explicit sideload confirmation (docs/14 §5).
import { createHash, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { NovaError } from '@nova/shared';
import { isZip, readZip, writeZip, type ZipLimits } from '../documents/zip.ts';
import { resolveInside, walkTree } from '../plugins/paths.ts';
import { EXTENSION_SIGNATURE_CONTEXT, publisherKeyOf, signDigest, verifyDigest } from './keys.ts';

export const EXTENSION_SIGNATURE_FILE = 'META-INF/nova-signature.json';
export const EXTENSION_MANIFEST_PATH = '.nova-plugin/extension.json';
/** What one bundle may hold (the plugin limits of docs/08 §9). */
export const BUNDLE_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};
/** Zip timestamps are fixed, so packing the same folder twice gives the same bytes. */
const PACK_TIME = new Date(Date.UTC(1980, 0, 2, 12));

const signatureFileSchema = z
  .object({
    v: z.literal(1),
    publisher: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type BundleSignatureFile = z.infer<typeof signatureFileSchema>;

export type BundleStatus = 'verified' | 'unverified' | 'invalid';
export type BundleReason =
  'unsigned' | 'untrusted' | 'signature_damaged' | 'digest_mismatch' | 'signature_invalid';

export interface BundleCheck {
  status: BundleStatus;
  /** Every entry but the signature file, by safe relative path. */
  files: Map<string, Uint8Array>;
  /** The D2 digest of `files`. */
  digest: string;
  /** The key whose signature verified (trusted or not); null when unsigned or invalid. */
  publisher: string | null;
  /** The owner's name for a trusted key. */
  publisherName: string | null;
  /** Why it is not verified; null when verified. */
  reason: BundleReason | null;
  /** The same in plain words. */
  message: string | null;
}

export interface TrustedKey {
  name?: string | null;
  key: string;
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The D2 digest: SHA-256 over the sorted `"<path>\n<sha256>\n"` lines of the files. */
export function extensionDigest(files: Iterable<readonly [string, Uint8Array]>): string {
  const lines: string[] = [];
  for (const [path, data] of files) lines.push(`${path}\n${sha256(data)}\n`);
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(lines.join(''));
}

/** A zip entry name as a safe relative path with `/` separators; throws `validation` otherwise. */
export function safeBundlePath(name: string): string {
  const bad = () =>
    new NovaError('validation', `the bundle contains an unsafe path: ${name.slice(0, 200)}`);
  if (!name || name.length > 512 || name.includes('\0') || name.includes('\\')) throw bad();
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw bad();
  const segs = name.split('/').filter((s) => s !== '.');
  if (!segs.length || segs.some((s) => s === '' || s === '..')) throw bad();
  return segs.join('/');
}

/** The entries of a bundle (signature file included), names checked. Throws `validation`. */
export function readBundleEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!isZip(bytes)) throw new NovaError('validation', 'the file is not a .novax bundle (a zip)');
  const raw = readZip(bytes, () => true, BUNDLE_LIMITS);
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of raw) {
    const safe = safeBundlePath(name);
    if (out.has(safe)) throw new NovaError('validation', `the bundle lists ${safe} twice`);
    out.set(safe, data);
  }
  return out;
}

function trustedName(trusted: readonly TrustedKey[], key: string): string | null | undefined {
  const t = trusted.find((x) => x.key === key);
  return t ? (t.name ?? null) : undefined;
}

/**
 * Check a bundle: its entries, its digest and its signature against `trusted` keys. `invalid` means
 * the signature does not match the contents (tampered or damaged): never install it. Throws
 * `validation` for a damaged, oversized or unsafe archive.
 */
export function verifyBundle(
  bytes: Uint8Array,
  opts: { trusted: readonly TrustedKey[] },
): BundleCheck {
  const files = readBundleEntries(bytes);
  const sigBytes = files.get(EXTENSION_SIGNATURE_FILE);
  files.delete(EXTENSION_SIGNATURE_FILE);
  return checkFiles(files, sigBytes ?? null, opts.trusted);
}

/** The signature check over files already read (a folder on the Hub has no signature file). */
export function checkFiles(
  files: Map<string, Uint8Array>,
  signatureFile: Uint8Array | null,
  trusted: readonly TrustedKey[],
): BundleCheck {
  const digest = extensionDigest(files);
  const base = { files, digest, publisher: null, publisherName: null };
  if (!signatureFile)
    return {
      ...base,
      status: 'unverified',
      reason: 'unsigned',
      message: 'the bundle is not signed',
    };
  let sig: BundleSignatureFile;
  try {
    const parsed = signatureFileSchema.safeParse(
      JSON.parse(Buffer.from(signatureFile).toString('utf8')),
    );
    if (!parsed.success) throw new Error('shape');
    sig = parsed.data;
  } catch {
    return {
      ...base,
      status: 'invalid',
      reason: 'signature_damaged',
      message: 'the bundle signature file is damaged',
    };
  }
  if (sig.digest !== digest)
    return {
      ...base,
      status: 'invalid',
      reason: 'digest_mismatch',
      message: 'the bundle was changed after it was signed',
    };
  if (!verifyDigest(EXTENSION_SIGNATURE_CONTEXT, digest, sig.signature, sig.publisher))
    return {
      ...base,
      status: 'invalid',
      reason: 'signature_invalid',
      message: 'the bundle signature does not verify',
    };
  const name = trustedName(trusted, sig.publisher);
  if (name === undefined)
    return {
      ...base,
      publisher: sig.publisher,
      status: 'unverified',
      reason: 'untrusted',
      message: 'the bundle is signed by a publisher you have not trusted',
    };
  return {
    ...base,
    publisher: sig.publisher,
    publisherName: name,
    status: 'verified',
    reason: null,
    message: null,
  };
}

/** The signature file for a set of files, signed with `privateKey`. */
export function bundleSignatureFile(
  files: Map<string, Uint8Array>,
  privateKey: KeyObject,
): BundleSignatureFile {
  const digest = extensionDigest(files);
  return {
    v: 1,
    publisher: publisherKeyOf(privateKey),
    digest,
    signature: signDigest(EXTENSION_SIGNATURE_CONTEXT, digest, privateKey),
  };
}

export interface PackedBundle {
  bytes: Uint8Array;
  digest: string;
  /** The signing key, or null for an unsigned bundle. */
  publisher: string | null;
  files: number;
}

/** A `.novax` from files (signature file excluded), signed when a key is given. */
export function packBundle(
  files: Map<string, Uint8Array>,
  opts: { privateKey?: KeyObject | null } = {},
): PackedBundle {
  const entries = [...files].filter(([p]) => p !== EXTENSION_SIGNATURE_FILE);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const clean = new Map(entries);
  const parts: [string, string | Uint8Array][] = [...entries];
  let publisher: string | null = null;
  if (opts.privateKey) {
    const sig = bundleSignatureFile(clean, opts.privateKey);
    publisher = sig.publisher;
    parts.push([EXTENSION_SIGNATURE_FILE, `${JSON.stringify(sig, null, 2)}\n`]);
  }
  return {
    bytes: writeZip(parts, PACK_TIME),
    digest: extensionDigest(clean),
    publisher,
    files: entries.length,
  };
}

/** Folders a pack leaves out: version control data and installed packages. */
function skipped(path: string): boolean {
  return path.split('/').some((s) => s === '.git' || s === 'node_modules');
}

/** The files of an extension folder, as a pack would take them (links leaving it refused). */
export function folderBundleFiles(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of walkTree(root)) {
    if (skipped(e.path) || e.path === EXTENSION_SIGNATURE_FILE) continue;
    out.set(safeBundlePath(e.path), readFileSync(e.source));
  }
  return out;
}

/** Write checked files into `dir` (created 0700); nothing outside it is written. */
export function extractBundle(files: Map<string, Uint8Array>, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    for (const [name, data] of files) {
      const to = resolveInside(dir, safeBundlePath(name), 'bundle entry');
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, data, { mode: 0o600, flag: 'wx' });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if (err instanceof NovaError) throw err;
    throw new NovaError('validation', 'the bundle could not be unpacked');
  }
}
