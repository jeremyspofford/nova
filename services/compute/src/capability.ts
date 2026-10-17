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
  if (hw.gpus.length) hardware.gpus = hw.gpus;
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
 * NVIDIA GPUs on Linux, from the driver's procfs entries (no process spawn). Other vendors and
 * VRAM sizes are left out until the compute module learns them (M6).
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
