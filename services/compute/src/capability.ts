// The node's capability document (docs/23 §3, contracts/schemas/device-capability.json): what the
// Hub's capability registry and router know about this machine. Only cheaply detectable facts
// are declared; nothing here is secret.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { arch, availableParallelism, release, totalmem, type } from 'node:os';
import { join } from 'node:path';
import type { BackendKind } from './backend.ts';

export interface Gpu {
  vendor?: string;
  name?: string;
  vramBytes?: number;
}

export interface HardwareFacts {
  arch: string;
  cores: number;
  ramBytes: number;
  gpus: Gpu[];
}

export interface OsFacts {
  family: string;
  version: string;
}

export interface CapabilityInput {
  deviceId: string;
  name: string;
  backendKind: BackendKind;
  models: string[];
  maxConcurrentJobs: number;
  /** Overrides for tests; detected otherwise. */
  hardware?: HardwareFacts;
  os?: OsFacts;
  /**
   * GPU memory a VRAM probe read (vram.ts): when it found GPUs, they replace the detected list
   * and carry `vramBytes` (FR-126, M7.5).
   */
  vram?: { vendor: string | null; name: string | null; totalBytes: number | null }[];
  /** The node's IANA time zone (`locale.timezone`): the zone its quiet hours are read in. */
  timeZone?: string;
  /** The node operator's own quiet hours (`scheduling.quietHours`, `--quiet-hours`). */
  quietHours?: string[];
}

const BACKEND_NAMES: Record<BackendKind, string> = {
  ollama: 'ollama',
  llamacpp: 'llama.cpp',
  openai_compatible: 'openai-compatible',
};

export type CapabilityDocument = Record<string, unknown> & {
  schemaVersion: 1;
  deviceId: string;
  roles: string[];
};

export function buildCapability(input: CapabilityInput): CapabilityDocument {
  const hw = input.hardware ?? detectHardware();
  const os = input.os ?? detectOs();
  const hardware: Record<string, unknown> = {
    arch: hw.arch,
    cores: Math.max(1, hw.cores),
    ramBytes: hw.ramBytes,
  };
  const probed: Gpu[] = (input.vram ?? []).map((g) => ({
    ...(g.vendor ? { vendor: g.vendor } : {}),
    ...(g.name ? { name: g.name } : {}),
    ...(g.totalBytes !== null ? { vramBytes: g.totalBytes } : {}),
  }));
  const gpus = probed.length ? probed : hw.gpus;
  if (gpus.length) hardware.gpus = gpus;
  return {
    schemaVersion: 1,
    deviceId: input.deviceId,
    name: input.name,
    roles: ['compute'],
    modules: ['compute'],
    hardware,
    os: { family: os.family, version: os.version },
    services: {
      computeBackends: [BACKEND_NAMES[input.backendKind]],
      modelsPresent: [...new Set(input.models)].sort().map((id) => ({ id })),
    },
    computePolicy: { maxConcurrentJobs: input.maxConcurrentJobs },
    ...(input.timeZone ? { locale: { timezone: input.timeZone } } : {}),
    ...(input.quietHours?.length ? { scheduling: { quietHours: [...input.quietHours] } } : {}),
  };
}

export function detectHardware(): HardwareFacts {
  return {
    arch: arch() === 'x64' ? 'x86_64' : arch() === 'arm64' ? 'aarch64' : arch(),
    cores: availableParallelism(),
    ramBytes: totalmem(),
    gpus: detectGpus(),
  };
}

export function detectOs(): OsFacts {
  const t = type();
  const family =
    t === 'Linux' ? 'linux' : t === 'Darwin' ? 'macos' : t === 'Windows_NT' ? 'windows' : t;
  return { family: family.toLowerCase(), version: release() };
}

/**
 * NVIDIA GPUs on Linux, from the driver's procfs entries (no process spawn). VRAM sizes and other
 * vendors come from a VRAM probe (vram.ts) when the node has one.
 */
export function detectGpus(root = '/proc/driver/nvidia/gpus'): Gpu[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((bus) => {
      try {
        const info = readFileSync(join(root, bus, 'information'), 'utf8');
        const model = /^Model:\s*(.+)$/m.exec(info)?.[1]?.trim();
        return [model ? { vendor: 'nvidia', name: model } : { vendor: 'nvidia' }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
