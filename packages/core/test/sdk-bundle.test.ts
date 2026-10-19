// `.novax` bundles and publisher signatures (FR-117, FR-049; ADR-097 D2): the digest over every
// entry, Ed25519 over the context line and the digest, verified / unverified (unsigned or an
// unknown key) / invalid (tampered, damaged, a signature of another kind); unsafe entry names and
// damaged archives refused; packing is reproducible; extraction stays inside its folder.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_INDEX_SIGNATURE_CONTEXT,
  EXTENSION_SIGNATURE_CONTEXT,
  EXTENSION_SIGNATURE_FILE,
  extensionDigest,
  extractBundle,
  folderBundleFiles,
  generatePublisherKeyPair,
  isPublisherKey,
  loadPublisherPrivateKey,
  packBundle,
  publisherFingerprint,
  publisherKeyOf,
  readBundleEntries,
  safeBundlePath,
  signDigest,
  verifyBundle,
  verifyDigest,
} from '../src/index.ts';
import { HELLO_DIR, copyHello, tempDir, writeTree } from './sdk-env.ts';

let dir: string;
beforeEach(() => {
  dir = tempDir('nova-sdk-bundle-');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const key = generatePublisherKeyPair();
const other = generatePublisherKeyPair();

describe('publisher keys', () => {
  it('generates, loads and signs with an Ed25519 key; the context separates kinds', () => {
    expect(isPublisherKey(key.publicKey)).toBe(true);
    expect(isPublisherKey('not-a-key')).toBe(false);
    expect(isPublisherKey('A'.repeat(43))).toBe(isPublisherKey('A'.repeat(43)));
    const priv = loadPublisherPrivateKey(key.privateKeyPem);
    expect(publisherKeyOf(priv)).toBe(key.publicKey);
    expect(publisherFingerprint(key.publicKey)).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
    const digest = 'a'.repeat(64);
    const sig = signDigest(EXTENSION_SIGNATURE_CONTEXT, digest, priv);
    expect(verifyDigest(EXTENSION_SIGNATURE_CONTEXT, digest, sig, key.publicKey)).toBe(true);
    // A catalog index signature can never pass as a bundle signature, or the other way round.
    expect(verifyDigest(CATALOG_INDEX_SIGNATURE_CONTEXT, digest, sig, key.publicKey)).toBe(false);
    expect(verifyDigest(EXTENSION_SIGNATURE_CONTEXT, 'b'.repeat(64), sig, key.publicKey)).toBe(
      false,
    );
    expect(verifyDigest(EXTENSION_SIGNATURE_CONTEXT, digest, sig, other.publicKey)).toBe(false);
    expect(verifyDigest(EXTENSION_SIGNATURE_CONTEXT, 'zz', sig, key.publicKey)).toBe(false);
    expect(() => signDigest(EXTENSION_SIGNATURE_CONTEXT, 'zz', priv)).toThrow(/digest/);
  });

  it('refuses a key file that is not an Ed25519 PEM', () => {
    expect(() => loadPublisherPrivateKey('nope')).toThrow(/PEM/);
  });
});

describe('packing and verifying', () => {
  it('packs the sample reproducibly; unsigned is unverified with the digest of its files', () => {
    const files = folderBundleFiles(HELLO_DIR);
    expect([...files.keys()]).toContain('.nova-plugin/extension.json');
    const a = packBundle(files);
    const b = packBundle(folderBundleFiles(HELLO_DIR));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.publisher).toBeNull();
    const check = verifyBundle(a.bytes, { trusted: [] });
    expect(check).toMatchObject({ status: 'unverified', reason: 'unsigned', publisher: null });
    expect(check.digest).toBe(a.digest);
    expect(check.digest).toBe(extensionDigest(files));
  });

  it('a trusted key verifies; an unknown key is unverified but names the publisher', () => {
    const packed = packBundle(folderBundleFiles(HELLO_DIR), {
      privateKey: loadPublisherPrivateKey(key.privateKeyPem),
    });
    expect(packed.publisher).toBe(key.publicKey);
    const entries = readBundleEntries(packed.bytes);
    expect(entries.has(EXTENSION_SIGNATURE_FILE)).toBe(true);
    const trusted = verifyBundle(packed.bytes, {
      trusted: [{ name: 'Examples', key: key.publicKey }],
    });
    expect(trusted).toMatchObject({
      status: 'verified',
      publisher: key.publicKey,
      publisherName: 'Examples',
      reason: null,
    });
    expect(trusted.files.has(EXTENSION_SIGNATURE_FILE)).toBe(false);
    const unknown = verifyBundle(packed.bytes, { trusted: [{ key: other.publicKey }] });
    expect(unknown).toMatchObject({
      status: 'unverified',
      reason: 'untrusted',
      publisher: key.publicKey,
      publisherName: null,
    });
  });

  it('a file changed after signing is invalid (tampered)', () => {
    const root = copyHello(dir);
    const files = folderBundleFiles(root);
    const signed = readBundleEntries(
      packBundle(files, { privateKey: loadPublisherPrivateKey(key.privateKeyPem) }).bytes,
    );
    const zip: Record<string, Uint8Array> = {};
    for (const [name, data] of signed) zip[name] = data;
    zip['extension.js'] = strToU8('export function activate() { /* evil */ }');
    const check = verifyBundle(zipSync(zip), { trusted: [{ key: key.publicKey }] });
    expect(check).toMatchObject({ status: 'invalid', reason: 'digest_mismatch' });
    // A digest rewritten to match, with the old signature: the signature fails.
    const files2 = new Map(signed);
    files2.delete(EXTENSION_SIGNATURE_FILE);
    files2.set('extension.js', zip['extension.js']);
    const sig = JSON.parse(Buffer.from(signed.get(EXTENSION_SIGNATURE_FILE)!).toString()) as Record<
      string,
      string
    >;
    zip[EXTENSION_SIGNATURE_FILE] = strToU8(
      JSON.stringify({ ...sig, digest: extensionDigest(files2) }),
    );
    expect(verifyBundle(zipSync(zip), { trusted: [{ key: key.publicKey }] })).toMatchObject({
      status: 'invalid',
      reason: 'signature_invalid',
    });
    zip[EXTENSION_SIGNATURE_FILE] = strToU8('{"v":2}');
    expect(verifyBundle(zipSync(zip), { trusted: [] })).toMatchObject({
      status: 'invalid',
      reason: 'signature_damaged',
    });
  });

  it('refuses unsafe entry names, damaged archives and non-zip files', () => {
    for (const name of ['../evil.js', '/abs.js', 'a/../../b', 'C:/x', 'a\\b', ''])
      expect(() => safeBundlePath(name)).toThrow(/unsafe path/);
    expect(safeBundlePath('./a/./b.js')).toBe('a/b.js');
    expect(() => verifyBundle(zipSync({ '../evil.js': strToU8('x') }), { trusted: [] })).toThrow(
      /unsafe path/,
    );
    expect(() => verifyBundle(strToU8('PK\u0003\u0004garbage'), { trusted: [] })).toThrow(/zip/);
    expect(() => verifyBundle(strToU8('hello'), { trusted: [] })).toThrow(/novax/);
  });

  it('extracts inside its folder only, and leaves nothing behind on failure', () => {
    const files = folderBundleFiles(HELLO_DIR);
    const out = join(dir, 'x');
    extractBundle(files, out);
    expect(readFileSync(join(out, 'extension.js'), 'utf8')).toContain('activate');
    const bad = join(dir, 'bad');
    expect(() => extractBundle(new Map([['../escape', new Uint8Array(1)]]), bad)).toThrow();
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });

  it('a pack leaves out .git, node_modules and an old signature file', () => {
    const root = writeTree(join(dir, 'f'), {
      'a.js': 'export {}',
      '.git/config': 'x',
      'node_modules/m/index.js': 'x',
      'META-INF/nova-signature.json': '{}',
    });
    expect([...folderBundleFiles(root).keys()]).toEqual(['a.js']);
  });
});
