// Onboarding, step 1 (docs/plans/M10-orchestration.md, Point 11; docs/plans/M10f.md §3): detect the
// device. The OS family decides what onboarding offers (a Linux inside WSL2 counts as Windows here:
// K3s inside WSL2 is out of scope for v1). The resources come from the hub's own hardware reading
// (models/hardware.ts), so setup and Settings › Models say the same thing.
import { readFileSync } from 'node:fs';
import { arch as osArch, cpus, platform as osPlatform, release as osRelease, totalmem } from 'node:os';
import type { Hardware } from '../models/hardware.ts';
import type { Purpose } from '../mesh/purposes.ts';

export const OS_FAMILIES = Object.freeze(['linux', 'macos', 'windows', 'wsl2'] as const);
export type OsFamily = (typeof OS_FAMILIES)[number];

export const OS_WORDS: Readonly<Record<OsFamily, string>> = Object.freeze({
  linux: 'Linux', macos: 'macOS', windows: 'Windows', wsl2: 'Linux inside Windows (WSL2)',
});

// Which family this machine is. `release` and `/proc/version` name Microsoft's kernel under WSL.
export function detectOs(o: { platform?: string; release?: string; env?: NodeJS.ProcessEnv; procVersion?: string | null } = {}): OsFamily {
  const platform = o.platform ?? osPlatform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  const env = o.env ?? process.env;
  let proc = o.procVersion;
  if (proc === undefined) { try { proc = readFileSync('/proc/version', 'utf8'); } catch { proc = null; } }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/i.test(o.release ?? osRelease()) || /microsoft|wsl/i.test(proc ?? '')) return 'wsl2';
  return 'linux';
}

// A stand-in detection, for tests and demos (`NOVA_DETECT_OS`): only the words change.
export function standInOs(v: unknown): OsFamily | null {
  return typeof v === 'string' && (OS_FAMILIES as readonly string[]).includes(v) ? v as OsFamily : null;
}

export interface DeviceFacts {
  os: OsFamily;
  arch: string;
  cpu: string;
  threads: number;
  ram_bytes: number;
  gpus: { name: string; vram_bytes: number; unified: boolean }[];
  disk_free_bytes: number | null;
}

export function factsFrom(os: OsFamily, hw: Hardware | null): DeviceFacts {
  if (!hw) return { os, arch: osArch(), cpu: cpus()[0]?.model?.trim() || 'a CPU', threads: cpus().length, ram_bytes: totalmem(), gpus: [], disk_free_bytes: null };
  return {
    os, arch: hw.arch, cpu: hw.cpu.model, threads: hw.cpu.threads, ram_bytes: hw.ram_bytes,
    gpus: hw.gpus.map((g) => ({ name: g.name, vram_bytes: g.vram_bytes, unified: g.unified })), disk_free_bytes: hw.disk?.free_bytes ?? null,
  };
}

const GB = 1024 ** 3;
const gb = (b: number) => `${Math.round(b / GB)} GB`;

// "a Linux computer (x64): 8 threads, 16 GB of memory, NVIDIA Example 12 GB, 200 GB free"
export function factsWords(f: DeviceFacts): string {
  const gpus = f.gpus.length
    ? f.gpus.map((g) => (g.unified ? `${g.name} (sharing the memory)` : `${g.name} with ${gb(g.vram_bytes)}`)).join(', ')
    : 'no GPU Nova can use';
  return `a ${OS_WORDS[f.os]} computer (${f.arch}): ${f.threads} threads, ${gb(f.ram_bytes)} of memory, ${gpus}${f.disk_free_bytes !== null ? `, ${gb(f.disk_free_bytes)} free on disk` : ''}`;
}

// What Nova recommends this hub is for, besides being the hub: it runs Nova's services always; it
// runs models when it has a GPU with 8 GB or more (or Apple's shared memory of 16 GB or more).
export function recommendedHubPurposes(f: DeviceFacts): Purpose[] {
  const gpu = f.gpus.some((g) => (g.unified ? f.ram_bytes >= 16 * GB : g.vram_bytes >= 8 * GB));
  return gpu ? ['hub-candidate', 'compute', 'general-server'] : ['hub-candidate', 'general-server'];
}
