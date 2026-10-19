// The `.novaexport` container (FR-105, ADR-097 D5): the streaming ZIP64 writer and the directory
// reader, the passphrase seal, and the lossless row codec.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  SEALED_MAGIC,
  ZipWriter,
  createSealer,
  dataTables,
  decodeCell,
  encodeCell,
  isSealedFile,
  listZip,
  readZipEntry,
  tableLines,
  unsealFile,
} from '../src/index.ts';

const LIMITS = { maxEntries: 1000, maxTotalBytes: 64 * 1024 * 1024 };
const FAST = { N: 2 ** 10, r: 8, p: 1 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-archive-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeZip(path: string, files: [string, Buffer][]): void {
  const zip = new ZipWriter(new Date('2026-10-01T12:00:00Z'));
  const out: Buffer[] = [];
  for (const [name, data] of files) {
    const e = zip.begin(name);
    out.push(e.header);
    // Several chunks per entry, as the exporter sends them.
    for (let at = 0; at < data.length; at += 7000)
      out.push(...e.push(data.subarray(at, at + 7000)));
    out.push(...e.finish());
  }
  out.push(...zip.end());
  writeFileSync(path, Buffer.concat(out));
}

function readAll(path: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of listZip(path, LIMITS)) {
    const parts: Buffer[] = [];
    readZipEntry(path, e, (c) => parts.push(Buffer.from(c)));
    out.set(e.name, Buffer.concat(parts));
  }
  return out;
}

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('zip container', () => {
  it('round-trips entries of every size, in order', () => {
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
    const files: [string, Buffer][] = [
      ['manifest.json', Buffer.from('{"a":1}')],
      ['tables/empty.jsonl', Buffer.alloc(0)],
      ['files/blobs/attachments/ab', big],
      ['files/ünïcode name.txt', Buffer.from('hé')],
    ];
    const path = join(dir, 'a.zip');
    writeZip(path, files);
    const got = readAll(path);
    expect([...got.keys()]).toEqual(files.map(([n]) => n));
    for (const [n, d] of files) expect(got.get(n)!.equals(d)).toBe(true);
  });

  it.skipIf(!hasUnzip)('is a standard zip other tools read', () => {
    const path = join(dir, 'std.zip');
    writeZip(path, [
      ['a.txt', Buffer.from('hello')],
      ['b/c.bin', Buffer.alloc(100_000, 3)],
    ]);
    const out = execFileSync('unzip', ['-t', path]).toString();
    expect(out).toContain('No errors detected');
  });

  it('refuses a damaged entry (CRC) and a truncated file', () => {
    const path = join(dir, 'd.zip');
    writeZip(path, [['x.txt', Buffer.from('a'.repeat(5000))]]);
    const bytes = readFileSync(path);
    // Flip a byte inside the deflated data.
    const flipped = Buffer.from(bytes);
    flipped[60] = flipped[60]! ^ 0xff;
    writeFileSync(join(dir, 'flip.zip'), flipped);
    expect(() => readAll(join(dir, 'flip.zip'))).toThrow(NovaError);
    writeFileSync(join(dir, 'cut.zip'), bytes.subarray(0, bytes.length - 30));
    expect(() => readAll(join(dir, 'cut.zip'))).toThrow(/damaged/);
  });

  it('stops an entry that grows past its declared size (no zip bombs)', () => {
    const path = join(dir, 'bomb.zip');
    writeZip(path, [['x.txt', Buffer.alloc(100_000)]]);
    const [entry] = listZip(path, LIMITS);
    expect(() => readZipEntry(path, { ...entry!, size: 10 }, () => undefined)).toThrow(
      /larger than it says/,
    );
    expect(() => listZip(path, { maxEntries: 10, maxTotalBytes: 100 })).toThrow(/too much data/);
    expect(() => listZip(path, { maxEntries: 0, maxTotalBytes: 1e9 })).toThrow(/too many entries/);
  });
});

describe('passphrase seal', () => {
  async function seal(pass: string, plain: Buffer): Promise<string> {
    const s = await createSealer(pass, FAST);
    const path = join(dir, 'sealed.novaexport');
    writeFileSync(path, Buffer.concat([s.head, s.update(plain), s.final()]));
    return path;
  }

  it('seals and opens with the passphrase; the magic marks it', async () => {
    const plain = Buffer.from('zip bytes '.repeat(50_000));
    const path = await seal('correct horse battery', plain);
    expect(readFileSync(path).subarray(0, 8).equals(SEALED_MAGIC)).toBe(true);
    expect(isSealedFile(path)).toBe(true);
    await unsealFile(path, join(dir, 'out'), 'correct horse battery');
    expect(readFileSync(join(dir, 'out')).equals(plain)).toBe(true);
  });

  it('refuses a wrong passphrase and a changed file', async () => {
    const path = await seal('correct horse battery', Buffer.from('secret data'));
    await expect(unsealFile(path, join(dir, 'w1'), 'wrong passphrase!')).rejects.toMatchObject({
      details: { reason: 'wrong_passphrase' },
    });
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 1;
    writeFileSync(path, bytes);
    await expect(unsealFile(path, join(dir, 'w2'), 'correct horse battery')).rejects.toMatchObject({
      details: { reason: 'wrong_passphrase' },
    });
  });

  it('seals in chunks: any size, each chunk checked; reordered, dropped or cut chunks refused', async () => {
    const CH = 1024;
    const sealChunked = async (plain: Buffer, pieces = 7) => {
      const s = await createSealer('chunked passphrase', FAST, CH);
      const out: Buffer[] = [s.head];
      // Fed in odd pieces, as the exporter does.
      const step = Math.max(1, Math.ceil(plain.length / pieces));
      for (let at = 0; at < plain.length; at += step)
        out.push(s.update(plain.subarray(at, at + step)));
      out.push(s.final());
      return { bytes: Buffer.concat(out), headLen: s.head.length };
    };
    for (const size of [0, 1, CH - 1, CH, CH + 1, 5 * CH, 5 * CH + 17]) {
      const plain = randomBytes(size);
      const { bytes } = await sealChunked(plain);
      const path = join(dir, `c${size}`);
      writeFileSync(path, bytes);
      await unsealFile(path, join(dir, `o${size}`), 'chunked passphrase');
      expect(readFileSync(join(dir, `o${size}`)).equals(plain), `size ${size}`).toBe(true);
    }
    const plain = randomBytes(5 * CH);
    const { bytes, headLen } = await sealChunked(plain);
    const sealed = CH + 16;
    const chunk = (i: number) => bytes.subarray(headLen + i * sealed, headLen + (i + 1) * sealed);
    const head = bytes.subarray(0, headLen);
    const tries: [string, Buffer, string][] = [
      [
        'swapped',
        Buffer.concat([head, chunk(1), chunk(0), bytes.subarray(headLen + 2 * sealed)]),
        'wrong_passphrase',
      ],
      ['cut at a chunk', Buffer.concat([head, chunk(0), chunk(1)]), 'archive_damaged'],
      [
        'middle dropped',
        Buffer.concat([head, chunk(0), bytes.subarray(headLen + 2 * sealed)]),
        'archive_damaged',
      ],
      [
        'changed late',
        (() => {
          const c = Buffer.from(bytes);
          c[headLen + 3 * sealed + 5]! ^= 1;
          return c;
        })(),
        'archive_damaged',
      ],
    ];
    for (const [what, data, reason] of tries) {
      const path = join(dir, what.replace(/ /g, '-'));
      writeFileSync(path, data);
      await expect(
        unsealFile(path, `${path}.out`, 'chunked passphrase'),
        what,
      ).rejects.toMatchObject({
        details: { reason },
      });
    }
  });

  it('refuses key parameters that would make the Hub allocate too much', async () => {
    await expect(createSealer('long enough pass', { N: 2 ** 20, r: 8, p: 1 })).rejects.toThrow(
      /unsupported key parameters/,
    );
    const path = await seal('long enough pass', Buffer.from('x'));
    const bytes = readFileSync(path);
    const hlen = bytes.readUInt32BE(8);
    const header = JSON.parse(bytes.subarray(12, 12 + hlen).toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...header, N: 2 ** 24 }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(forged.length);
    writeFileSync(
      path,
      Buffer.concat([bytes.subarray(0, 8), len, forged, bytes.subarray(12 + hlen)]),
    );
    await expect(unsealFile(path, join(dir, 'f'), 'long enough pass')).rejects.toThrow(
      /unsupported key parameters/,
    );
  });
});

describe('row codec', () => {
  it('keeps every SQLite type exactly', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (a, b REAL, c INTEGER, d TEXT, e BLOB)');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?)');
    ins.run(2.0, 0.5, 9007199254740993n, 'text', Buffer.from([0, 1, 2]));
    ins.run(null, Infinity, -5n, '', null);
    ins.run(7n, 3, 1n, '{"$i":"1"}', Buffer.alloc(0));
    const [info] = dataTables(db);
    const lines = [...tableLines(db, info!)];
    const copy = new DatabaseSync(':memory:');
    copy.exec('CREATE TABLE t (a, b REAL, c INTEGER, d TEXT, e BLOB)');
    const ins2 = copy.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?)');
    for (const l of lines) {
      const o = JSON.parse(l) as Record<string, unknown>;
      ins2.run(...['a', 'b', 'c', 'd', 'e'].map((k) => decodeCell(o[k], 't')));
    }
    expect([...tableLines(copy, info!)]).toEqual(lines);
    const types = (d: DatabaseSync) =>
      d
        .prepare('SELECT typeof(a) a, typeof(b) b, typeof(c) c, typeof(d) d, typeof(e) e FROM t')
        .all();
    expect(types(copy)).toEqual(types(db));
  });

  it('encodes and refuses what it must', () => {
    expect(encodeCell(2n ** 60n)).toEqual({ $i: String(2n ** 60n) });
    expect(encodeCell(1.5)).toBe(1.5);
    expect(encodeCell(4)).toEqual({ $r: 4 });
    expect(encodeCell(-Infinity)).toEqual({ $r: '-Infinity' });
    expect(() => encodeCell({})).toThrow(TypeError);
    expect(() => decodeCell({ $x: 1 }, 't')).toThrow(/unknown form/);
    expect(() => decodeCell([1], 't')).toThrow(NovaError);
    expect(decodeCell({ $b: 'AAE=' }, 't')).toEqual(Buffer.from([0, 1]));
  });
});
