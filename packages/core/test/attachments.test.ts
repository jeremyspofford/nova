// Blob encryption at rest (FR-149 baseline): sealed blobs round-trip, legacy plaintext blobs
// stay readable, tampering and unknown keys fail closed.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import {
  DATA_KEY_REF,
  blobEncryption,
  loadDataKey,
  readAttachmentBlob,
  useBlobKey,
  writeAttachmentBlob,
} from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-blobs-'));
});
afterEach(() => {
  useBlobKey(dir, null);
  rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MAGIC = Buffer.from([0x00, 0x4e, 0x56, 0x42, 0x01]);

describe('blob encryption', () => {
  it('writes plaintext until a key is registered (the pre-M3 layout)', () => {
    expect(blobEncryption(dir)).toBe(false);
    const bytes = Buffer.from('hello plain');
    const blob = writeAttachmentBlob(dir, bytes);
    expect(blob).toEqual({ sha256: sha(bytes), blobPath: `blobs/attachments/${sha(bytes)}` });
    expect(readFileSync(join(dir, blob.blobPath))).toEqual(bytes);
    expect(readAttachmentBlob(dir, blob.blobPath)).toEqual(bytes);
  });

  it('seals new blobs and reads them back; the file never holds the plaintext', () => {
    useBlobKey(dir, randomBytes(32));
    expect(blobEncryption(dir)).toBe(true);
    const bytes = Buffer.from('confidential attachment text');
    const blob = writeAttachmentBlob(dir, bytes);
    expect(blob.sha256).toBe(sha(bytes)); // content addressing stays on the plaintext
    const raw = readFileSync(join(dir, blob.blobPath));
    expect(raw.subarray(0, 5)).toEqual(MAGIC);
    expect(raw.includes(Buffer.from('confidential'))).toBe(false);
    expect(readAttachmentBlob(dir, blob.blobPath)).toEqual(bytes);
    // Identical content shares one blob.
    expect(writeAttachmentBlob(dir, bytes)).toEqual(blob);
    expect(readFileSync(join(dir, blob.blobPath))).toEqual(raw);
  });

  it('reads legacy plaintext blobs and seals them when the same content is written again', () => {
    const bytes = Buffer.from('written before M3');
    const blob = writeAttachmentBlob(dir, bytes);
    useBlobKey(dir, randomBytes(32));
    expect(readAttachmentBlob(dir, blob.blobPath)).toEqual(bytes);
    writeAttachmentBlob(dir, bytes);
    expect(readFileSync(join(dir, blob.blobPath)).subarray(0, 5)).toEqual(MAGIC);
    expect(readAttachmentBlob(dir, blob.blobPath)).toEqual(bytes);
  });

  it('reads a legacy plaintext blob that happens to start with the sealed header', () => {
    const bytes = Buffer.concat([MAGIC, Buffer.from('binary file that looks sealed')]);
    const blob = writeAttachmentBlob(dir, bytes);
    useBlobKey(dir, randomBytes(32));
    expect(readAttachmentBlob(dir, blob.blobPath)).toEqual(bytes);
  });

  it('keeps blobs readable after the key changes, and drops sealing on null', () => {
    useBlobKey(dir, randomBytes(32));
    const a = writeAttachmentBlob(dir, Buffer.from('under key one'));
    useBlobKey(dir, randomBytes(32));
    const b = writeAttachmentBlob(dir, Buffer.from('under key two'));
    expect(readAttachmentBlob(dir, a.blobPath).toString()).toBe('under key one');
    expect(readAttachmentBlob(dir, b.blobPath).toString()).toBe('under key two');
    useBlobKey(dir, null);
    expect(blobEncryption(dir)).toBe(false);
    const c = writeAttachmentBlob(dir, Buffer.from('plain again'));
    expect(readFileSync(join(dir, c.blobPath)).toString()).toBe('plain again');
    expect(readAttachmentBlob(dir, a.blobPath).toString()).toBe('under key one');
    expect(() => useBlobKey(dir, Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('fails closed on tampering, swapped blobs, truncation and unknown keys', () => {
    useBlobKey(dir, randomBytes(32));
    const a = writeAttachmentBlob(dir, Buffer.from('blob a'));
    const b = writeAttachmentBlob(dir, Buffer.from('blob b'));
    const pathA = join(dir, a.blobPath);
    const sealedA = readFileSync(pathA);
    const flipped = Buffer.from(sealedA);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    writeFileSync(pathA, flipped);
    expect(() => readAttachmentBlob(dir, a.blobPath)).toThrow(/integrity check/);
    // A valid sealed blob moved to another address fails too (the name is bound in).
    writeFileSync(pathA, readFileSync(join(dir, b.blobPath)));
    expect(() => readAttachmentBlob(dir, a.blobPath)).toThrow(/integrity check/);
    writeFileSync(pathA, sealedA.subarray(0, 20));
    expect(() => readAttachmentBlob(dir, a.blobPath)).toThrow(/integrity check/);
    writeFileSync(pathA, sealedA);
    const other = mkdtempSync(join(tmpdir(), 'nova-blobs-other-'));
    try {
      mkdirSync(join(other, 'blobs', 'attachments'), { recursive: true });
      writeFileSync(join(other, a.blobPath), sealedA);
      expect(() => readAttachmentBlob(other, a.blobPath)).toThrow(/key this Hub does not have/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('checks the plaintext hash after decrypting, and refuses paths outside the data dir', () => {
    const key = randomBytes(32);
    useBlobKey(dir, key);
    const real = writeAttachmentBlob(dir, Buffer.from('original'));
    // Seal different content under the real blob's name with the real key (the documented
    // format: magic | key id | nonce | tag | ciphertext, AAD = header + name).
    const id = createHash('sha256').update('nova-blob-key\0').update(key).digest().subarray(0, 8);
    const header = Buffer.concat([MAGIC, id]);
    const nonce = randomBytes(12);
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    const forged = Buffer.from('forged');
    c.setAAD(Buffer.concat([header, Buffer.from(real.sha256)]), { plaintextLength: forged.length });
    const body = Buffer.concat([c.update(forged), c.final()]);
    writeFileSync(join(dir, real.blobPath), Buffer.concat([header, nonce, c.getAuthTag(), body]));
    expect(() => readAttachmentBlob(dir, real.blobPath)).toThrow(/integrity check/);
    expect(() => readAttachmentBlob(dir, '../outside')).toThrow(/missing/);
    expect(() => readAttachmentBlob(dir, 'blobs/attachments/absent')).toThrow(/missing/);
  });

  it('binds the name into the ciphertext, so a renamed copy does not open', () => {
    useBlobKey(dir, randomBytes(32));
    const blob = writeAttachmentBlob(dir, Buffer.from('renamed'));
    writeFileSync(
      join(dir, 'blobs', 'attachments', 'copy'),
      readFileSync(join(dir, blob.blobPath)),
    );
    expect(() => readAttachmentBlob(dir, 'blobs/attachments/copy')).toThrow(/integrity check/);
  });
});

describe('loadDataKey', () => {
  it('creates a 32-byte key once and returns the same key after', async () => {
    const secrets = new MemorySecretStore();
    const a = await loadDataKey(secrets);
    expect(a).toHaveLength(32);
    expect(await secrets.has(DATA_KEY_REF)).toBe(true);
    expect((await loadDataKey(secrets)).equals(a)).toBe(true);
  });

  it('fails closed on a damaged key', async () => {
    const secrets = new MemorySecretStore();
    await secrets.put(DATA_KEY_REF, 'dG9vIHNob3J0');
    await expect(loadDataKey(secrets)).rejects.toThrow(/damaged/);
    await secrets.put(DATA_KEY_REF, `${randomBytes(32).toString('base64')}!`);
    await expect(loadDataKey(secrets)).rejects.toThrow(/damaged/);
  });
});
