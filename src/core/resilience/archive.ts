// The encrypted copy of a backup (M7 plan §3): one file per backup, a ustar archive of the backup
// folder encrypted with AES-256-GCM under a key kept in the vault. Written and read in chunks, so
// a big home never has to fit in memory. The header (who, when, which key) is bound to the
// ciphertext as associated data; nothing is unpacked until the tag has checked out, so a copy
// that was changed or cut short is refused whole, never half restored.
//
//   "NOVABK1\n" · u32 header length · header JSON · ciphertext · 16-byte tag
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

const MAGIC = Buffer.from('NOVABK1\n');
const CHUNK = 1 << 20;

export interface ArchiveHeader { v: 1; id: string; seq: number; at: string; alg: 'aes-256-gcm'; nonce: string; key_fp: string }

export const keyFingerprint = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

// ---- ustar ------------------------------------------------------------------------------------

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(path: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    // ustar splits a long path at a slash: up to 155 bytes of folders, up to 100 of the rest.
    const cut = path.lastIndexOf('/', path.length - 2);
    let at = cut;
    while (at > 0 && (Buffer.byteLength(path.slice(at + 1)) > 100 || Buffer.byteLength(path.slice(0, at)) > 155)) at = path.lastIndexOf('/', at - 1);
    if (at <= 0) throw new Error(`A file's path is too long to archive: ${path}`);
    prefix = path.slice(0, at);
    name = path.slice(at + 1);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(octal(type === '5' ? 0o755 : 0o600, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function walk(root: string, rel = ''): { path: string; dir: boolean }[] {
  const out: { path: string; dir: boolean }[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { out.push({ path: r, dir: true }); out.push(...walk(root, r)); } else if (e.isFile()) out.push({ path: r, dir: false });
  }
  return out;
}

// ---- writing ----------------------------------------------------------------------------------

// Archives `dir` (a backup folder) into `file`, encrypted under `key`. Written beside the final
// name and moved into place only when complete.
export function encryptDir(dir: string, file: string, key: Buffer, meta: { id: string; seq: number; at: string }): ArchiveHeader {
  const header: ArchiveHeader = { v: 1, id: meta.id, seq: meta.seq, at: meta.at, alg: 'aes-256-gcm', nonce: randomBytes(12).toString('base64'), key_fp: keyFingerprint(key) };
  const head = Buffer.from(JSON.stringify(header));
  const tmp = `${file}.partial`;
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(tmp, 'w', 0o600);
  try {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    writeSync(fd, MAGIC);
    writeSync(fd, len);
    writeSync(fd, head);
    const c = createCipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'base64'));
    c.setAAD(head);
    const put = (b: Buffer) => { const out = c.update(b); if (out.length) writeSync(fd, out); };
    const buf = Buffer.alloc(CHUNK);
    for (const e of walk(dir)) {
      if (e.dir) { put(tarHeader(`${e.path}/`, 0, '5')); continue; }
      const size = statSync(join(dir, e.path)).size;
      put(tarHeader(e.path, size, '0'));
      const src = openSync(join(dir, e.path), 'r');
      try {
        let done = 0;
        while (done < size) {
          const n = readSync(src, buf, 0, Math.min(CHUNK, size - done), done);
          if (n <= 0) throw new Error(`${e.path} got shorter while it was being archived.`);
          put(buf.subarray(0, n));
          done += n;
        }
      } finally {
        closeSync(src);
      }
      put(Buffer.alloc((512 - (size % 512)) % 512));
    }
    put(Buffer.alloc(1024));
    const last = c.final();
    if (last.length) writeSync(fd, last);
    writeSync(fd, c.getAuthTag());
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, file);
  return header;
}

// ---- reading ----------------------------------------------------------------------------------

export function readHeader(file: string): ArchiveHeader {
  const fd = openSync(file, 'r');
  try {
    return headerOf(fd).header;
  } finally {
    closeSync(fd);
  }
}

function headerOf(fd: number): { header: ArchiveHeader; head: Buffer; start: number } {
  const first = Buffer.alloc(12);
  if (readSync(fd, first, 0, 12, 0) !== 12 || !first.subarray(0, 8).equals(MAGIC)) throw new Error('This isn’t one of Nova’s encrypted backups.');
  const n = first.readUInt32BE(8);
  if (n > 64 * 1024) throw new Error('This encrypted backup’s header is damaged.');
  const head = Buffer.alloc(n);
  if (readSync(fd, head, 0, n, 12) !== n) throw new Error('This encrypted backup is cut short.');
  const header = JSON.parse(head.toString('utf8')) as ArchiveHeader;
  if (header.v !== 1 || header.alg !== 'aes-256-gcm') throw new Error('This encrypted backup is in a form this Nova can’t read.');
  return { header, head, start: 12 + n };
}

// Decrypts `file` into `outDir` (which must not exist yet). The whole file is checked before
// anything is unpacked: the plaintext goes to a scratch archive first, and only after the tag
// matched is it unpacked.
export function decryptTo(file: string, key: Buffer, outDir: string): ArchiveHeader {
  const fd = openSync(file, 'r');
  const tarFile = `${outDir}.tar.partial`;
  let header: ArchiveHeader;
  try {
    const h = headerOf(fd);
    header = h.header;
    if (header.key_fp !== keyFingerprint(key)) throw new Error('This encrypted backup was made with a different key than the one in the vault.');
    const size = fstatSync(fd).size;
    if (size < h.start + 16) throw new Error('This encrypted backup is cut short.');
    const tag = Buffer.alloc(16);
    readSync(fd, tag, 0, 16, size - 16);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'base64'));
    d.setAAD(h.head);
    d.setAuthTag(tag);
    mkdirSync(dirname(outDir), { recursive: true });
    const out = openSync(tarFile, 'w', 0o600);
    try {
      const buf = Buffer.alloc(CHUNK);
      for (let at = h.start; at < size - 16;) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - 16 - at), at);
        if (n <= 0) break;
        const p = d.update(buf.subarray(0, n));
        if (p.length) writeSync(out, p);
        at += n;
      }
      try { d.final(); } catch { throw new Error('This encrypted backup was changed or damaged after it was made, so Nova won’t use it.'); }
    } finally {
      closeSync(out);
    }
  } catch (e) {
    rmSync(tarFile, { force: true });
    throw e;
  } finally {
    closeSync(fd);
  }
  try {
    untar(tarFile, outDir);
  } finally {
    rmSync(tarFile, { force: true });
  }
  return header;
}

function untar(tarFile: string, outDir: string): void {
  const fd = openSync(tarFile, 'r');
  const root = normalize(outDir);
  mkdirSync(root, { recursive: true });
  try {
    const block = Buffer.alloc(512);
    const buf = Buffer.alloc(CHUNK);
    let at = 0;
    for (;;) {
      if (readSync(fd, block, 0, 512, at) !== 512) throw new Error('The archive inside the backup is cut short.');
      at += 512;
      if (block.every((b) => b === 0)) break;
      const str = (from: number, len: number) => block.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
      const name = str(0, 100);
      const prefix = str(345, 155);
      const path = prefix ? `${prefix}/${name}` : name;
      const size = parseInt(str(124, 12).trim() || '0', 8);
      const type = String.fromCharCode(block[156] ?? 48);
      const rel = normalize(path.replace(/\/$/, ''));
      if (!rel || rel.startsWith('..') || rel.startsWith(sep) || rel.split(sep).includes('..')) throw new Error(`The archive names a path outside the backup: ${path}`);
      const dest = join(root, rel);
      if (type === '5') mkdirSync(dest, { recursive: true });
      else if (type === '0' || type === '\0') {
        mkdirSync(dirname(dest), { recursive: true });
        const out = openSync(dest, 'w', 0o600);
        try {
          let left = size;
          while (left > 0) {
            const n = readSync(fd, buf, 0, Math.min(CHUNK, left), at);
            if (n <= 0) throw new Error('The archive inside the backup is cut short.');
            writeSync(out, buf.subarray(0, n));
            at += n;
            left -= n;
          }
        } finally {
          closeSync(out);
        }
        at += (512 - (size % 512)) % 512;
      } else throw new Error(`The archive holds something that isn’t a file or a folder: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}
