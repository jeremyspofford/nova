// A coding run's preview (M10c): the project's own preview command, started in the worktree at the
// reviewed commit, on 127.0.0.1 and a free port, kept running while the person reviews. It runs code
// the agent wrote, so it starts only after the person's OK (the check step, tier 2), and Nova checks
// that it listens on this computer alone before it shows the link.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
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

// Every TCP socket listening on this machine, read from the kernel's own tables (Linux only; null
// elsewhere): address, port and socket inode. /proc/net/tcp writes each IPv4 address as one 32-bit
// word in the machine's order, and tcp6 as four; this reads them as little-endian, which x86 and ARM
// machines are.
export interface Listening { address: string; port: number; inode: string }
export function listening(read: (f: string) => string = (f) => readFileSync(f, 'utf8')): Listening[] | null {
  if (platform() !== 'linux') return null;
  const out: Listening[] = [];
  const word = (hex: string) => [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map((b) => parseInt(b, 16));
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
    let text: string;
    try { text = read(file); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== '0A') continue;
      const [addr, p] = (f[1] ?? '').split(':');
      if (!addr) continue;
      const port = parseInt(p ?? '', 16);
      const inode = f[9] ?? '';
      if (!v6) { out.push({ address: word(addr).join('.'), port, inode }); continue; }
      const bytes = [0, 8, 16, 24].flatMap((i) => word(addr.slice(i, i + 8)));
      const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
      const address = zeros(0, 15) && bytes[15] === 1 ? '::1' : zeros(0, 16) ? '::' : zeros(0, 10) && bytes[10] === 255 && bytes[11] === 255 ? `::ffff:${bytes.slice(12).join('.')}` : bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
      out.push({ address, port, inode });
    }
  }
  return out;
}

// The addresses something listens on at `port` (Linux only; null elsewhere).
export function listeners(port: number, read?: (f: string) => string): string[] | null {
  return listening(read)?.filter((l) => l.port === port).map((l) => l.address) ?? null;
}

// Every process in a process group (Linux only; null elsewhere).
export function groupPids(pgid: number): number[] | null {
  if (platform() !== 'linux') return null;
  const out: number[] = [];
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return null; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === pgid) out.push(Number(n));
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

// What a process group listens on: every listening socket any of its processes holds (the review
// of PR #239, item 11: not only the port Nova gave it). Linux only; null elsewhere.
export function groupListeners(pgid: number): Listening[] | null {
  const pids = groupPids(pgid);
  const all = listening();
  if (!pids || !all) return null;
  const inodes = new Set<string>();
  for (const pid of pids) {
    let fds: string[] = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]!); } catch { /* closed meanwhile */ }
    }
  }
  return all.filter((l) => inodes.has(l.inode));
}

// What the preview's group listens on off this computer, in words, or null when nothing does.
export function wideListeners(pgid: number, port: number): string | null {
  const heard = [...(listening()?.filter((l) => l.port === port) ?? []), ...(groupListeners(pgid) ?? [])];
  const wide = heard.filter((l) => !loopbackAddress(l.address));
  if (!wide.length) return null;
  const said = [...new Set(wide.map((l) => (l.address === '0.0.0.0' || l.address === '::' ? `every address (${l.address})` : l.address) + (l.port === port ? '' : ` on port ${l.port}`)))];
  return said.join(' and ');
}

export const loopbackAddress = (a: string) => a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);

export interface Started { child: ChildProcess; url: string; port: number; status: number; loopback: 'yes' | 'unchecked'; start: string | null; output: () => string }

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
    // Everything its process group listens on, twice, a moment apart: a second server the command
    // starts beside the one that answered is seen too, if it is up by then.
    for (const wait of [0, 400]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const wide = wideListeners(child.pid!, o.port);
      if (wide) throw new CoreError('forbidden', `The preview listened on ${wide}, not only on this computer, so Nova stopped it: what the agent wrote isn’t shown to your network before you’ve reviewed it. Make it listen on HOST (127.0.0.1), which Nova sets.`);
    }
    const heard = listeners(o.port);
    return { child, url, port: o.port, status, loopback: heard && heard.length ? 'yes' : 'unchecked', start: procStart(child.pid!), output: () => output };
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

// When a process started, in the kernel's clock ticks since boot (/proc/<pid>/stat, field 22), or
// null where there is no /proc or no such process. With the pid, it names one process: a pid can be
// used again, a pid and its start time can't.
export function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) is in parentheses and may hold spaces: count from after it.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

// After a restart: a preview a stopped Nova left behind is ended, its whole group, only if its leader
// is still the process Nova started (the same pid and start time), or the leader is gone and only
// its group is left (a group's id isn't given to a new process while the group lives). A pid now
// used by another process is left alone. Linux only (start times come from /proc).
export function stopRecorded(pid: number, start: string | null): boolean {
  if (platform() !== 'linux' || !Number.isInteger(pid) || pid <= 1) return false;
  const now = procStart(pid);
  if (now !== null && (start === null || now !== start)) return false;
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { return false; }
}

export function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
