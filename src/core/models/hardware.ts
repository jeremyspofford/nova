// What a device can run models on (M6 plan §2): CPU, memory, GPUs and their memory, free disk,
// its network interfaces (the MAC Wake-on-LAN needs) and whether a transcription runtime is on its
// PATH. Read with what the platform has: nvidia-smi, rocm-smi, system_profiler, /proc, Node's os.
//
// The device agent carries this file to paired computers (mesh/agent.ts) and sends what it finds
// in its heartbeat, so it imports Node's built-ins only. A tool that isn't there is skipped, not an
// error: a machine without a GPU tool simply reports no GPU, and says how it looked.
import { execFile } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { arch, cpus, freemem, hostname, networkInterfaces, platform, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';

export interface Gpu {
  vendor: 'nvidia' | 'amd' | 'apple' | 'other';
  name: string;
  vram_bytes: number;
  vram_free_bytes: number | null;
  // Apple silicon: the GPU shares the machine's memory.
  unified: boolean;
}

// `wol`: whether the card answers a magic packet, as the device read it (`unknown` when it can't
// tell, and from agents older than the field). `off` means Nova can't wake it on this card.
export type Wol = 'magic' | 'off' | 'unknown';
export interface Nic { name: string; mac: string; address: string; netmask: string; broadcast: string | null; wol?: Wol }

export interface Hardware {
  at: string;
  platform: string;
  arch: string;
  hostname: string;
  cpu: { model: string; threads: number };
  ram_bytes: number;
  ram_free_bytes: number;
  gpus: Gpu[];
  disk: { path: string; total_bytes: number; free_bytes: number } | null;
  network: Nic[];
  // A transcription runtime found on the PATH (whisper.cpp and friends), or null.
  whisper: string | null;
  // A Mac's GPU memory limit (sysctl iogpu.wired_limit_mb) when it has been raised; null at the
  // macOS default (0), off a Mac, or unreadable. Absent from agents older than this field.
  gpu_wired_limit_bytes?: number | null;
  // How each part was read, so the person can see where a number came from.
  sources: string[];
}

// Runs a tool and returns what it printed, or null when it isn't there or fails. Never a shell.
export type Run = (program: string, args: string[]) => Promise<string | null>;

export const runTool: Run = (program, args) => new Promise((resolve) => {
  execFile(program, args, { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
});

const MIB = 1024 * 1024;
const WHISPER = ['whisper-cli', 'whisper-cpp', 'whisper-server', 'whisper', 'faster-whisper'];

// Without holding the event loop: five names across every PATH folder is a stat each, and on a long
// WSL PATH (/mnt/c folders) that blocked Nova for over a second just after it started.
async function onPath(names: string[]): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const n of names) for (const d of dirs) for (const e of exts) if (await access(join(d, n + e)).then(() => true, () => false)) return join(d, n + e);
  return null;
}

async function nvidia(run: Run): Promise<Gpu[] | null> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']);
  if (out === null) return null;
  const gpus: Gpu[] = [];
  for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, total, free] = line.split(',').map((x) => x.trim());
    const t = Number(total);
    if (!name || !Number.isFinite(t) || t <= 0) continue;
    gpus.push({ vendor: 'nvidia', name, vram_bytes: t * MIB, vram_free_bytes: Number.isFinite(Number(free)) ? Number(free) * MIB : null, unified: false });
  }
  return gpus;
}

async function rocm(run: Run): Promise<Gpu[] | null> {
  const out = await run('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json']);
  if (out === null) return null;
  try {
    const j = JSON.parse(out) as Record<string, Record<string, string>>;
    return Object.values(j).filter((c) => c && typeof c === 'object' && c['VRAM Total Memory (B)']).map((c) => {
      const total = Number(c['VRAM Total Memory (B)']);
      const used = Number(c['VRAM Total Used Memory (B)']);
      return { vendor: 'amd' as const, name: c['Card series'] ?? c['Card model'] ?? 'AMD GPU', vram_bytes: total, vram_free_bytes: Number.isFinite(used) ? total - used : null, unified: false };
    });
  } catch { return []; }
}

// Apple silicon shares memory between CPU and GPU; macOS lets the GPU use about three quarters.
async function apple(run: Run, ram: number): Promise<Gpu[] | null> {
  const out = await run('system_profiler', ['SPDisplaysDataType', '-json']);
  if (out === null) return null;
  try {
    const list = (JSON.parse(out) as { SPDisplaysDataType?: Record<string, string>[] }).SPDisplaysDataType ?? [];
    return list.map((g) => {
      const name = g.sppci_model ?? g._name ?? 'GPU';
      const vram = /(\d+)\s*GB/i.exec(g.spdisplays_vram ?? g.spdisplays_vram_shared ?? '')?.[1];
      const silicon = /apple/i.test(name) || !vram;
      return { vendor: silicon ? 'apple' as const : 'other' as const, name, vram_bytes: silicon ? Math.floor(ram * 0.75) : Number(vram) * 1024 * MIB, vram_free_bytes: null, unified: silicon };
    });
  } catch { return []; }
}

// The slice of node:child_process.execFile this file uses, so a test can stand in for it.
export type ExecFileLike = (file: string, args: string[], o: { timeout: number; maxBuffer: number; windowsHide: boolean }, cb: (err: Error | null, stdout: string | Buffer) => void) => unknown;

// A Mac's GPU wired-memory limit in bytes, or null: 0 is the macOS default ("not raised"), and an
// error, a timeout, odd output or another platform say nothing. A fixed path and args, no shell.
export function gpuWiredLimit(os: string, exec: ExecFileLike = execFile): Promise<number | null> {
  if (os !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    exec('/usr/sbin/sysctl', ['-n', 'iogpu.wired_limit_mb'], { timeout: 2000, maxBuffer: 64, windowsHide: true }, (err, stdout) => {
      const t = err ? '' : String(stdout).trim();
      const mb = /^\d{1,9}$/.test(t) ? Number(t) : 0;
      resolve(mb > 0 ? mb * MIB : null);
    });
  });
}

// Free memory: Linux says what is available (cache counts as free); elsewhere Node's figure.
function memAvailable(): { bytes: number; source: string } {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) return { bytes: Number(m[1]) * 1024, source: '/proc/meminfo' };
  } catch { /* not Linux */ }
  return { bytes: freemem(), source: 'os' };
}

function ipv4ToInt(a: string): number { return a.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0; }
function intToIpv4(n: number): string { return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.'); }
export function broadcastOf(address: string, netmask: string): string | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address) || !/^\d+\.\d+\.\d+\.\d+$/.test(netmask)) return null;
  return intToIpv4((ipv4ToInt(address) & ipv4ToInt(netmask)) | (~ipv4ToInt(netmask) >>> 0));
}

function nics(): Nic[] {
  const out: Nic[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4' || !a.mac || a.mac === '00:00:00:00:00:00') continue;
      out.push({ name, mac: a.mac.toLowerCase(), address: a.address, netmask: a.netmask, broadcast: broadcastOf(a.address, a.netmask) });
    }
  }
  return out.slice(0, 8);
}

// Whether each card answers a magic packet (the WoL ADR's inventory addition). Linux: ethtool's
// "Wake-on:" when it is installed (g is the magic packet, d is off), else the card's
// /sys/class/net/<if>/device/power/wakeup; a Wi-Fi card is `unknown`. macOS: pmset's "womp". Windows:
// a wired card that `powercfg /devicequery wake_armed` doesn't list can't wake the computer (`off`);
// an armed one is `magic` only when Get-NetAdapterPowerManagement says its magic packet is on, which
// often needs an administrator, so otherwise `unknown`. Matched by MAC. `unknown` never blocks a
// wake; only `off` does.
export async function withWol(list: Nic[], os: string, run: Run, read: (p: string) => string | null = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }): Promise<Nic[]> {
  if (os === 'darwin') {
    const womp = /^\s*womp\s+(\d)/m.exec((await run('pmset', ['-g'])) ?? '')?.[1];
    return list.map((n) => ({ ...n, wol: womp === '1' ? 'magic' : womp === '0' ? 'off' : 'unknown' }));
  }
  if (os === 'win32') {
    const cards = windowsWol(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_WOL]));
    return list.map((n) => ({ ...n, wol: cards.get(n.mac.toLowerCase().replace(/-/g, ':')) ?? 'unknown' }));
  }
  if (os !== 'linux') return list.map((n) => ({ ...n, wol: 'unknown' }));
  const out: Nic[] = [];
  for (const n of list) {
    if (!/^[\w.-]{1,15}$/.test(n.name) || /DEVTYPE=wlan/.test(read(`/sys/class/net/${n.name}/uevent`) ?? '')) { out.push({ ...n, wol: 'unknown' }); continue; }
    const on = /Wake-on:\s*(\w+)/.exec((await run('ethtool', [n.name])) ?? '')?.[1];
    const sys = read(`/sys/class/net/${n.name}/device/power/wakeup`)?.trim();
    const wol: Wol = on !== undefined ? (on.includes('g') ? 'magic' : 'off') : sys === 'enabled' ? 'magic' : sys === 'disabled' ? 'off' : 'unknown';
    out.push({ ...n, wol });
  }
  return out;
}

// The fixed Windows reading: each physical card's MAC, whether Windows lets it wake the computer, its
// magic-packet setting when readable, and its medium. Nothing in it comes from the hub.
export const WIN_WOL = '$a = @(powercfg /devicequery wake_armed); @(Get-NetAdapter -Physical | ForEach-Object { $m = try { [string](Get-NetAdapterPowerManagement -Name $_.Name -ErrorAction Stop).WakeOnMagicPacket } catch { "" }; [pscustomobject]@{ mac = $_.MacAddress; armed = ($a -contains $_.InterfaceDescription); magic = $m; media = [string]$_.PhysicalMediaType } }) | ConvertTo-Json -Compress';

// What WIN_WOL printed, by MAC (lower case, colons). Odd output says nothing (every card `unknown`).
export function windowsWol(out: string | null): Map<string, Wol> {
  const m = new Map<string, Wol>();
  let rows: unknown;
  try { rows = JSON.parse(out ?? ''); } catch { return m; }
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    if (typeof r !== 'object' || r === null) continue;
    const { mac, armed, magic, media } = r as Record<string, unknown>;
    if (typeof mac !== 'string' || !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac)) continue;
    // Wi-Fi wakes only on networks it's joined to while asleep: `unknown`, as on Linux.
    const wol: Wol = media !== '802.3' ? 'unknown' : armed === false ? 'off' : magic === 'Disabled' ? 'off' : armed === true && magic === 'Enabled' ? 'magic' : 'unknown';
    m.set(mac.toLowerCase().replace(/-/g, ':'), wol);
  }
  return m;
}

export async function detectHardware(o: { run?: Run; exec?: ExecFileLike; diskPath?: string; now?: () => Date } = {}): Promise<Hardware> {
  const run = o.run ?? runTool;
  const sources: string[] = ['os'];
  const ram = totalmem();
  const free = memAvailable();
  if (free.source !== 'os') sources.push(free.source);
  let gpus: Gpu[] = [];
  const os = platform();
  // Each tool only where it can exist; the first that answers is the GPU list.
  const tries: [string, () => Promise<Gpu[] | null>][] = os === 'darwin'
    ? [['system_profiler', () => apple(run, ram)]]
    : [['nvidia-smi', () => nvidia(run)], ['rocm-smi', () => rocm(run)]];
  for (const [name, f] of tries) {
    const g = await f();
    if (g === null) continue;
    sources.push(name);
    gpus = g;
    if (g.length) break;
  }
  const wired = await gpuWiredLimit(os, o.exec);
  if (wired !== null) sources.push('sysctl');
  let disk: Hardware['disk'] = null;
  const path = o.diskPath ?? process.cwd();
  try {
    const s = statfsSync(path);
    disk = { path, total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize };
    sources.push('statfs');
  } catch { /* an unreadable disk: said as unknown */ }
  const c = cpus();
  return {
    at: (o.now ?? (() => new Date()))().toISOString(), platform: os, arch: arch(), hostname: hostname(),
    cpu: { model: (c[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(), threads: c.length },
    ram_bytes: ram, ram_free_bytes: free.bytes, gpus, disk, network: await withWol(nics(), os, run), whisper: await onPath(WHISPER), gpu_wired_limit_bytes: wired, sources,
  };
}

// ---- what a device sends -------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 120): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const bytes = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 2 ** 53 ? Math.floor(v) : 0);
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// One DNS label: a computer's own name, which a heartbeat may report (with or without .local).
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Whether an address stays among the person's own machines: loopback, the private LAN ranges,
// link-local, the shared range mesh VPNs use (100.64.0.0/10), the IPv4 limited broadcast, and the
// ranges reserved for examples (never routed on the internet; Nova's tests and docs use them).
// Anything else could be a machine on the internet.
export function privateAddress(a: string): boolean {
  const h = a.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (!IPV4.test(h)) return false;
  const [a1, a2, a3] = h.split('.').map(Number) as [number, number, number, number];
  if (h.split('.').some((x) => Number(x) > 255)) return false;
  return a1 === 10 || a1 === 127 || (a1 === 172 && a2 >= 16 && a2 <= 31) || (a1 === 192 && a2 === 168) || (a1 === 169 && a2 === 254)
    || (a1 === 100 && a2 >= 64 && a2 <= 127) || h === '255.255.255.255'
    || (a1 === 192 && a2 === 0 && a3 === 2) || (a1 === 198 && a2 === 51 && a3 === 100) || (a1 === 203 && a2 === 0 && a3 === 113);
}

// A MAC one card can own: not the all-zero MAC, and not a group (multicast or broadcast) MAC, whose
// first byte has its low bit set. A magic packet naming a group MAC would wake nothing in particular.
const unicastMac = (mac: string): boolean => mac !== '00:00:00:00:00:00' && (parseInt(mac.slice(0, 2), 16) & 1) === 0;

// A heartbeat's hardware, kept to what Nova uses and to sane sizes. Throws on what isn't hardware.
export function checkHardware(v: unknown): Hardware {
  if (!isObj(v)) throw new Error('hardware must be an object.');
  const cpu = isObj(v.cpu) ? v.cpu : {};
  const gpus = Array.isArray(v.gpus) ? v.gpus.slice(0, 8).filter(isObj).map((g) => ({
    vendor: (['nvidia', 'amd', 'apple'].includes(g.vendor as string) ? g.vendor : 'other') as Gpu['vendor'],
    name: text(g.name) || 'GPU', vram_bytes: bytes(g.vram_bytes), vram_free_bytes: g.vram_free_bytes == null ? null : bytes(g.vram_free_bytes), unified: g.unified === true,
  })) : [];
  const d = isObj(v.disk) ? v.disk : null;
  const network = Array.isArray(v.network) ? v.network.slice(0, 8).filter(isObj).flatMap((n) => {
    const mac = text(n.mac, 17).toLowerCase();
    const address = text(n.address, 15);
    // Only an address on the person's own network is kept: Nova sends this computer prompts and
    // wake packets at what it reports, and a public address would take them off the devices.
    if (!MAC.test(mac) || !unicastMac(mac) || !IPV4.test(address) || !privateAddress(address)) return [];
    const netmask = IPV4.test(text(n.netmask, 15)) ? text(n.netmask, 15) : '255.255.255.0';
    const wol: Wol = n.wol === 'magic' || n.wol === 'off' ? n.wol : 'unknown';
    return [{ name: text(n.name, 32) || 'net', mac, address, netmask, broadcast: broadcastOf(address, netmask), wol }];
  }) : [];
  const ram = bytes(v.ram_bytes);
  // Trusted only as a whole number of bytes the machine's memory can hold; anything else is unknown.
  const w = v.gpu_wired_limit_bytes;
  const wired = typeof w === 'number' && Number.isSafeInteger(w) && w > 0 && w <= ram ? w : null;
  return {
    at: text(v.at, 40) || new Date().toISOString(), platform: text(v.platform, 20) || 'unknown', arch: text(v.arch, 20) || 'unknown', hostname: hostLabel(v.hostname),
    cpu: { model: text(cpu.model) || 'unknown', threads: Math.min(4096, bytes(cpu.threads)) },
    ram_bytes: ram, ram_free_bytes: bytes(v.ram_free_bytes), gpus,
    disk: d ? { path: text(d.path, 200), total_bytes: bytes(d.total_bytes), free_bytes: bytes(d.free_bytes) } : null,
    network, whisper: text(v.whisper, 200) || null, gpu_wired_limit_bytes: wired,
    sources: Array.isArray(v.sources) ? v.sources.slice(0, 8).map((s) => text(s, 30)).filter(Boolean) : [],
  };
}

// A reported host name, as one plain label ("desk", or "desk.local" read as "desk"); a dotted
// name could be anyone's on the internet, so it is dropped.
function hostLabel(v: unknown): string {
  const h = text(v, 80).toLowerCase().replace(/\.local\.?$/, '');
  return LABEL.test(h) ? h : '';
}

// ---- in words ------------------------------------------------------------------------------------

export const gb = (b: number): string => {
  const g = b / 1024 ** 3;
  return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1).replace(/\.0$/, '')} GB` : `${Math.max(1, Math.round(b / MIB))} MB`;
};

// The memory a model can sit in on this device: the biggest GPU's (unified memory counts), or
// none, in which case models run on the CPU from RAM.
export function modelMemory(h: Hardware): { bytes: number; on: 'gpu' | 'cpu'; words: string } {
  const g = [...h.gpus].sort((a, b) => b.vram_bytes - a.vram_bytes)[0];
  if (g && g.vram_bytes >= 2 * 1024 ** 3) return { bytes: g.vram_bytes, on: 'gpu', words: g.unified ? `${g.name}, sharing ${gb(g.vram_bytes)} of memory` : `${g.name} with ${gb(g.vram_bytes)}` };
  return { bytes: Math.floor(h.ram_bytes * 0.5), on: 'cpu', words: `no GPU Nova can use, so models run on the CPU from ${gb(h.ram_bytes)} of memory` };
}

// `shared`: what a unified-memory GPU may use, from the fit engine on the hub (this file can't
// import it); without it, the GPU's own figure.
export function hardwareWords(h: Hardware, shared?: number): string {
  const parts = [
    h.gpus.length ? h.gpus.map((g) => `${g.name} (${gb(g.unified && shared !== undefined ? shared : g.vram_bytes)}${g.unified ? ' shared' : ''})`).join(', ') : 'no GPU',
    `${gb(h.ram_bytes)} memory`, `${h.cpu.threads} threads`,
    h.disk ? `${gb(h.disk.free_bytes)} free disk` : 'disk space unknown',
  ];
  return parts.join(' · ');
}
