// A coding run's preview (M10c): the project's own preview command, started in the worktree at the
// reviewed commit, on 127.0.0.1 and a free port, kept running while the person reviews. It runs code
// the agent wrote, so it starts only after the person's OK (the check step, tier 2), and Nova checks
// that it listens on this computer alone before it shows the link.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { platform } from 'node:os';
import { CoreError } from '../errors.ts';
import { trackChild } from '../children.ts';

// A port nobody listens on now. Something else could take it before the preview does; then the
// preview fails to start, and the step says so (nothing is exposed).
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

// The addresses something listens on at `port`, read from the kernel's own tables (Linux only;
// null elsewhere). /proc/net/tcp writes each IPv4 address as one 32-bit word in the machine's order,
// and tcp6 as four; this reads them as little-endian, which x86 and ARM machines are.
export function listeners(port: number, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): string[] | null {
  if (platform() !== 'linux') return null;
  const out: string[] = [];
  const word = (hex: string) => [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map((b) => parseInt(b, 16));
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
    let text: string;
    try { text = read(file); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== '0A') continue;
      const [addr, p] = (f[1] ?? '').split(':');
      if (!addr || parseInt(p ?? '', 16) !== port) continue;
      if (!v6) { out.push(word(addr).join('.')); continue; }
      const bytes = [0, 8, 16, 24].flatMap((i) => word(addr.slice(i, i + 8)));
      const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
      if (zeros(0, 15) && bytes[15] === 1) out.push('::1');
      else if (zeros(0, 16)) out.push('::');
      else if (zeros(0, 10) && bytes[10] === 255 && bytes[11] === 255) out.push(`::ffff:${bytes.slice(12).join('.')}`);
      else out.push(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
  }
  return out;
}

export const loopbackAddress = (a: string) => a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);

export interface Started { child: ChildProcess; url: string; port: number; status: number; loopback: 'yes' | 'unchecked'; output: () => string }

const tail = (s: string) => s.trimEnd().split('\n').slice(-12).join('\n').slice(-2000);

// Starts the preview and waits until it answers an HTTP request at its address (any status below
// 500). Throws, with the end of its output, when it exits first, doesn't answer in time, or listens
// on an address other than loopback; the process is stopped then.
export async function startPreview(o: { command: string; cwd: string; env: Record<string, string>; port: number; timeoutMs: number; signal?: AbortSignal }): Promise<Started> {
  const child = trackChild(spawn('/bin/sh', ['-c', o.command], { cwd: o.cwd, env: { ...o.env, HOST: '127.0.0.1', PORT: String(o.port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }), { group: true });
  let output = '';
  const keep = (d: Buffer) => { output = (output + d.toString('utf8')).slice(-16_000); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let exited: number | null | undefined;
  child.once('exit', (code) => { exited = code; });
  const url = `http://127.0.0.1:${o.port}/`;
  const until = Date.now() + o.timeoutMs;
  let status = 0;
  try {
    for (;;) {
      if (o.signal?.aborted) throw new CoreError('conflict', 'Stopped before the preview answered.');
      if (exited !== undefined) throw new CoreError('conflict', `The preview command exited (code ${exited ?? 'none'}) before it answered.${output.trim() ? ` Its last words: ${tail(output)}` : ''}`);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
        await res.body?.cancel();
        if (res.status < 500) { status = res.status; break; }
      } catch { /* not listening yet */ }
      if (Date.now() > until) throw new CoreError('conflict', `The preview didn’t answer at ${url} within ${Math.round(o.timeoutMs / 1000)} s.${output.trim() ? ` Its last words: ${tail(output)}` : ''}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const heard = listeners(o.port);
    const wide = heard?.filter((a) => !loopbackAddress(a)) ?? [];
    if (wide.length) throw new CoreError('forbidden', `The preview listened on ${wide.map((a) => (a === '0.0.0.0' || a === '::' ? `every address (${a})` : a)).join(' and ')}, not only on this computer, so Nova stopped it: what the agent wrote isn’t shown to your network before you’ve reviewed it. Make it listen on HOST (127.0.0.1), which Nova sets.`);
    return { child, url, port: o.port, status, loopback: heard && heard.length ? 'yes' : 'unchecked', output: () => output };
  } catch (e) {
    stopPreview(child);
    throw e;
  }
}

export function stopPreview(child: ChildProcess | { pid?: number | undefined } | null | undefined): void {
  const pid = child?.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000);
  t.unref();
}

export function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
