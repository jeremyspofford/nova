// Shared by the Nova Computer tests (M10a): whether Docker is here (they skip with the reason when
// it isn't), the pinned image pulled once if missing (the build's one download), and a digest of a
// workspace container's whole filesystem.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { IMAGE } from '../../src/core/computer/policy.ts';

const run = (args: string[], timeout = 30_000) => new Promise<{ code: number; out: string }>((ok) => {
  execFile('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => ok({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: `${stdout}${stderr}` }));
});

let ready: Promise<string | null> | null = null;

// Null when Docker and the image are ready; otherwise why the test skips.
export function dockerSkip(): Promise<string | null> {
  ready ??= (async () => {
    const v = await run(['version', '--format', '{{.Server.Version}}'], 15_000).catch(() => ({ code: 1, out: 'no docker CLI' }));
    if (v.code !== 0) return `Docker isn’t available here (${v.out.trim().split('\n')[0] || 'no daemon'}), so the Nova Computer tests that need it are skipped.`;
    if ((await run(['image', 'inspect', IMAGE])).code !== 0) {
      const p = await run(['pull', IMAGE], 600_000);
      if (p.code !== 0) return `The pinned image ${IMAGE} isn’t here and couldn’t be pulled (${p.out.trim().split('\n').at(-1)}), so the Nova Computer tests that need it are skipped.`;
    }
    return null;
  })();
  return ready;
}

export const docker = run;

// Every container a test makes carries this label, unique to the test process, so a test removes
// exactly its own (and never another Nova's or a person's) in its `finally`.
export const TEST_LABELS: Record<string, string> = { 'nova.computer.test': `p${process.pid}-${Date.now().toString(36)}` };

export async function removeTestContainers(): Promise<void> {
  const [k, v] = Object.entries(TEST_LABELS)[0]!;
  const ps = await run(['ps', '-aq', '--filter', `label=${k}=${v}`]);
  const ids = ps.out.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{12,64}$/.test(s));
  if (ids.length) await run(['rm', '-f', ...ids], 60_000);
  // A checkpoint's image is committed from a labelled container, so it carries the label too.
  const im = await run(['images', '-q', '--filter', `label=${k}=${v}`]);
  const imgs = [...new Set(im.out.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{12,64}$/.test(s)))];
  if (imgs.length) await run(['rmi', '-f', ...imgs], 120_000);
}

// A ledger task, once it stops moving.
export async function settled(core: { ledger: { get(id: string): { state: string } } }, id: string, states = ['done', 'failed', 'waiting', 'cancelled']): Promise<import('../../src/core/ledger.ts').Task> {
  for (let i = 0; i < 4800; i++) {
    const t = core.ledger.get(id);
    if (states.includes(t.state)) return t as import('../../src/core/ledger.ts').Task;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task ${id} never settled: ${core.ledger.get(id).state}`);
}

// The identity a workspace records for its folder at creation (device and inode), as the adapter
// checks it before every mount, copy, digest and reset.
export function folderIdOf(path: string): { dev: string; ino: string } {
  const st = lstatSync(path, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino) };
}

// The processes running in a container, as the host sees them (`docker top`).
export async function processes(container: string): Promise<string[]> {
  const r = await run(['top', container, '-o', 'pid,args']);
  return r.code === 0 ? r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
}

// A TLS stand-in for a declared host, with a throwaway self-signed certificate made for this test
// (openssl), on this machine's loopback. Null when openssl isn't here. `seen` counts connections,
// `secure` the TLS handshakes that completed. `sink` never reads; `flood` sends that many MiB.
export async function tlsStandIn(reply: string, o: { sink?: boolean; flood?: number } = {}): Promise<{ server: import('node:tls').Server; port: number; seen: () => number; secure: () => number; close: () => void } | null> {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tls = await import('node:tls');
  const dir = mkdtempSync(join(tmpdir(), 'nova-tls-standin-'));
  const made = await new Promise<boolean>((ok) => execFile('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=stand-in', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:declared.test', '-days', '1'], { timeout: 30_000 }, (e) => ok(!e)));
  if (!made) { rmSync(dir, { recursive: true, force: true }); return null; }
  const key = readFileSync(join(dir, 'k.pem'));
  const cert = readFileSync(join(dir, 'c.pem'));
  rmSync(dir, { recursive: true, force: true });
  let seen = 0;
  let secure = 0;
  const live = new Set<import('node:net').Socket>();
  const server = tls.createServer({ key, cert }, (s) => {
    secure++;
    s.on('error', () => {});
    if (o.sink) { s.pause(); return; }
    if (o.flood) {
      const chunk = Buffer.alloc(1 << 20, 0x62);
      let left = o.flood;
      const pump = () => { while (left > 0) { left--; if (!s.write(chunk)) { s.once('drain', pump); return; } } s.end(); };
      pump();
      return;
    }
    s.end(`HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(reply)}\r\nconnection: close\r\n\r\n${reply}`);
  });
  server.on('connection', (s) => { seen++; live.add(s); s.on('close', () => live.delete(s)); });
  server.on('tlsClientError', () => {});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  return { server, port: (server.address() as { port: number }).port, seen: () => seen, secure: () => secure, close: () => { for (const s of live) s.destroy(); server.close(); } };
}

interface Entry { line: string; left: number; pad: number; hash: ReturnType<typeof createHash> | null; meta: 'x' | 'L' | 'K' | 'g' | null; parts: Buffer[] }

// A digest of a container's whole filesystem, read from the host with `docker export` (so files
// the workspace's own user can't read count too): every entry's path, type, mode, owner, size, link
// target and the bytes of each file. Modification times are left out. The project folder is a
// bind mount, which export leaves out; it is compared on the host side.
export function exportDigest(container: string): Promise<{ digest: string; entries: number; bytes: number }> {
  return new Promise((ok, fail) => {
    const p = spawn('docker', ['export', container], { stdio: ['ignore', 'pipe', 'pipe'] });
    const h = createHash('sha256');
    let buf: Buffer = Buffer.alloc(0);
    let entries = 0;
    let bytes = 0;
    let cur: Entry | null = null;
    let pending: { path?: string; link?: string } = {};
    const oct = (b: Buffer) => parseInt(b.toString('latin1').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    const str = (b: Buffer) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
    const finish = (e: Entry) => {
      if (e.meta === 'x') {
        for (const rec of Buffer.concat(e.parts).toString('utf8').split('\n')) {
          const m = /^\d+ (path|linkpath)=([\s\S]*)$/.exec(rec);
          if (m) pending[m[1] === 'path' ? 'path' : 'link'] = m[2];
        }
      } else if (e.meta === 'L') pending.path = str(Buffer.concat(e.parts));
      else if (e.meta === 'K') pending.link = str(Buffer.concat(e.parts));
      else if (e.meta === null) { h.update(`${e.line} ${e.hash ? e.hash.digest('hex') : ''}\n`); entries++; }
    };
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (cur) {
          if (cur.left > 0) {
            const take = Math.min(cur.left, buf.length);
            if (!take) return;
            const part = buf.subarray(0, take);
            if (cur.meta) cur.parts.push(Buffer.from(part)); else cur.hash?.update(part);
            cur.left -= take;
            buf = buf.subarray(take);
            if (cur.left > 0) return;
          }
          if (buf.length < cur.pad) return;
          buf = buf.subarray(cur.pad);
          finish(cur);
          cur = null;
          continue;
        }
        if (buf.length < 512) return;
        const hd = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (hd.every((b) => b === 0)) continue;
        const type = String.fromCharCode(hd[156]!).replace('\0', '0');
        const size = oct(hd.subarray(124, 136));
        const pad = (512 - (size % 512)) % 512;
        if (type === 'g') { cur = { line: '', left: size, pad, hash: null, meta: 'g', parts: [] }; continue; }
        const meta = type === 'x' || type === 'L' || type === 'K' ? type : null;
        if (meta) { cur = { line: '', left: size, pad, hash: null, meta, parts: [] }; continue; }
        const prefix = str(hd.subarray(345, 500));
        const name = str(hd.subarray(0, 100));
        const path = (pending.path ?? (prefix ? `${prefix}/${name}` : name)).replace(/\/$/, '');
        const link = pending.link ?? str(hd.subarray(157, 257));
        pending = {};
        bytes += size;
        const line = `${type} ${path} ${oct(hd.subarray(100, 108)).toString(8)} ${oct(hd.subarray(108, 116))}:${oct(hd.subarray(116, 124))} ${size} ${link}`;
        cur = { line, left: size, pad, hash: createHash('sha256'), meta: null, parts: [] };
      }
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok({ digest: h.digest('hex'), entries, bytes }) : fail(new Error(`docker export: ${err}`))));
  });
}
