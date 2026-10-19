// Sealing an export with a passphrase (FR-105, ADR-097 D5): scrypt turns the passphrase into a
// 256-bit key and the zip is encrypted in 1 MiB chunks, each its own AES-256-GCM message, so a
// sealed archive may carry the vault's secrets and has no size limit (one GCM message stops at
// 64 GiB). The file is "NOVAEXP1" | header length (u32, big-endian) | header JSON | chunks; a chunk
// is its ciphertext and 16-byte tag. A chunk's nonce is the header's 7-byte prefix, the chunk
// number (u32, big-endian) and a last-chunk flag, and the magic and header are every chunk's
// additional data: chunks cannot be reordered, dropped, cut off at the end or moved to another
// archive, and the parameters cannot be swapped. Each chunk is checked before its plaintext is
// written, and the importer only stages the plaintext until the last one verified.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type BinaryLike,
} from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { NovaError } from '@nova/shared';

export const SEALED_MAGIC = Buffer.from('NOVAEXP1', 'ascii');

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** 128 MiB of memory per derivation. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

/** Plaintext bytes per chunk. */
export const SEAL_CHUNK = 1024 * 1024;

interface SealHeader {
  v: 1;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm-chunked';
  chunk: number;
  N: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
}

const MAX_HEADER = 4096;
const TAG = 16;
const MAX_CHUNKS = 2 ** 32 - 1;

function checkParams(p: ScryptParams): void {
  const pow2 = Number.isInteger(Math.log2(p.N));
  // Bounded so a crafted archive cannot make the Hub allocate gigabytes to derive a key.
  if (!pow2 || p.N < 2 ** 10 || p.N > 2 ** 18 || p.r < 1 || p.r > 16 || p.p < 1 || p.p > 4)
    throw new NovaError('validation', 'the archive asks for unsupported key parameters', {
      details: { reason: 'archive_damaged' },
    });
}

function deriveKey(passphrase: string, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  checkParams(p);
  const secret: BinaryLike = Buffer.from(passphrase.normalize('NFC'), 'utf8');
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      32,
      { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r * p.p + 32 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function chunkIv(prefix: Buffer, index: number, last: boolean): Buffer {
  if (index > MAX_CHUNKS) throw new NovaError('validation', 'the archive is too large to seal');
  const iv = Buffer.alloc(12);
  prefix.copy(iv, 0, 0, 7);
  iv.writeUInt32BE(index, 7);
  iv[11] = last ? 1 : 0;
  return iv;
}

export interface Sealer {
  /** The magic and header, sent first. */
  head: Buffer;
  /** Sealed chunks for the data so far (a partial chunk waits for more). */
  update(chunk: Uint8Array): Buffer;
  /** The last chunk (possibly empty plaintext), marked as last. */
  final(): Buffer;
}

/** Start sealing a stream with a passphrase. */
export async function createSealer(
  passphrase: string,
  params: ScryptParams = DEFAULT_SCRYPT,
  chunkSize: number = SEAL_CHUNK,
): Promise<Sealer> {
  const salt = randomBytes(16);
  const prefix = randomBytes(7);
  const key = await deriveKey(passphrase, salt, params);
  const header: SealHeader = {
    v: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm-chunked',
    chunk: chunkSize,
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64'),
    nonce: prefix.toString('base64'),
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  const head = Buffer.concat([SEALED_MAGIC, len, json]);
  let index = 0;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  const seal = (plain: Buffer, last: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', key, chunkIv(prefix, index++, last), {
      authTagLength: TAG,
    });
    c.setAAD(head);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  return {
    head,
    update: (chunk) => {
      if (!chunk.length) return Buffer.alloc(0);
      pending.push(Buffer.from(chunk));
      pendingLen += chunk.length;
      const out: Buffer[] = [];
      // A full chunk is sealed only once more data follows: the last chunk must carry the flag.
      while (pendingLen > chunkSize) {
        const all = Buffer.concat(pending);
        out.push(seal(all.subarray(0, chunkSize), false));
        const rest = all.subarray(chunkSize);
        pending = [rest];
        pendingLen = rest.length;
      }
      return Buffer.concat(out);
    },
    final: () => {
      const last = seal(Buffer.concat(pending), true);
      pending = [];
      pendingLen = 0;
      return last;
    },
  };
}

/** Whether a file starts like a sealed archive. */
export function isSealedFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(SEALED_MAGIC.length);
    const n = readSync(fd, head, 0, head.length, 0);
    return n === head.length && head.equals(SEALED_MAGIC);
  } finally {
    closeSync(fd);
  }
}

const damaged = (why = 'its sealed header is unreadable') =>
  new NovaError('validation', `the archive is damaged: ${why}`, {
    details: { reason: 'archive_damaged' },
  });

/**
 * Decrypt a sealed archive at `src` into `dest` (a new file), one verified chunk at a time.
 * Throws `validation` `{reason: wrong_passphrase}` when the first chunk does not open (a wrong
 * passphrase, or a changed start) and `{reason: archive_damaged}` for a later chunk; `dest` is
 * then incomplete and the caller discards it.
 */
export async function unsealFile(src: string, dest: string, passphrase: string): Promise<void> {
  const fd = openSync(src, 'r');
  let out = -1;
  try {
    const size = fstatSync(fd).size;
    const fixed = Buffer.alloc(SEALED_MAGIC.length + 4);
    if (readSync(fd, fixed, 0, fixed.length, 0) !== fixed.length) throw damaged();
    if (!fixed.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) throw damaged();
    const hlen = fixed.readUInt32BE(SEALED_MAGIC.length);
    if (hlen < 2 || hlen > MAX_HEADER || fixed.length + hlen + TAG > size) throw damaged();
    const json = Buffer.alloc(hlen);
    if (readSync(fd, json, 0, hlen, fixed.length) !== hlen) throw damaged();
    let header: SealHeader;
    try {
      header = JSON.parse(json.toString('utf8')) as SealHeader;
    } catch {
      throw damaged();
    }
    const chunk = Number(header.chunk);
    if (
      header.v !== 1 ||
      header.kdf !== 'scrypt' ||
      header.cipher !== 'aes-256-gcm-chunked' ||
      !Number.isInteger(chunk) ||
      chunk < 1024 ||
      chunk > 16 * 1024 * 1024
    )
      throw damaged();
    const salt = Buffer.from(String(header.salt), 'base64');
    const prefix = Buffer.from(String(header.nonce), 'base64');
    if (salt.length !== 16 || prefix.length !== 7) throw damaged();
    const key = await deriveKey(passphrase, salt, {
      N: Number(header.N),
      r: Number(header.r),
      p: Number(header.p),
    });
    const aad = Buffer.concat([fixed, json]);
    const start = fixed.length + hlen;
    const body = size - start;
    const sealedChunk = chunk + TAG;
    const count = Math.max(1, Math.ceil(body / sealedChunk));
    const lastLen = body - (count - 1) * sealedChunk;
    if (lastLen < TAG) throw damaged('it ends early');
    out = openSync(dest, 'wx', 0o600);
    const buf = Buffer.alloc(sealedChunk);
    for (let i = 0; i < count; i++) {
      const last = i === count - 1;
      const len = last ? lastLen : sealedChunk;
      if (readSync(fd, buf, 0, len, start + i * sealedChunk) !== len)
        throw damaged('it ends early');
      const d = createDecipheriv('aes-256-gcm', key, chunkIv(prefix, i, last), {
        authTagLength: TAG,
      });
      d.setAAD(aad);
      d.setAuthTag(buf.subarray(len - TAG, len));
      let plain: Buffer;
      try {
        plain = Buffer.concat([d.update(buf.subarray(0, len - TAG)), d.final()]);
      } catch {
        if (i === 0)
          throw new NovaError('validation', 'the passphrase is wrong or the archive was changed', {
            details: { reason: 'wrong_passphrase' },
          });
        throw damaged(`its sealed part ${i + 1} of ${count} was changed`);
      }
      if (plain.length) writeSync(out, plain);
    }
  } finally {
    closeSync(fd);
    if (out >= 0) closeSync(out);
  }
}
