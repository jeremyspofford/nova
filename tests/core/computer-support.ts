// Shared by the Nova Computer tests (M10a): whether Docker is here (they skip with the reason when
// it isn't), the pinned image pulled once if missing (the build's one download), and a digest of a
// workspace container's whole filesystem.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
