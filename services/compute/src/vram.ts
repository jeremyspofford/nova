// GPU memory on the compute node (FR-126, M7.5): total VRAM goes into the signed capability
// document (`hardware.gpus[].vramBytes`), totals and use into every heartbeat (`vram`). It is read
// through a `VramProbe`: `nvidia-smi` or `rocm-smi` (run with execFile, no shell, a short timeout
// and a capped output), or a fake in tests. Nothing here changes the GPU; a probe that fails
// reports nothing rather than guessing.
import { execFile } from 'node:child_process';

export interface GpuMemory {
  index: number;
  vendor: string | null;
  name: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
}

export interface VramProbe {
  /** `nvidia-smi`, `rocm-smi`, `fake` or `none`. */
  readonly source: string;
  read(): Promise<GpuMemory[]>;
}

/** Runs a program without a shell; resolves with its exit code and standard output. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>;

export const execRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
      },
    );
  });

const MIB = 1024 * 1024;

function count(text: string | undefined, unit = 1): number | null {
  if (text === undefined) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * unit) : null;
}

/**
 * `nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv,noheader,nounits`:
 * one line per GPU, sizes in MiB.
 */
export function parseNvidiaSmi(csv: string): GpuMemory[] {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): GpuMemory[] => {
      const [index, name, total, used] = line.split(',').map((x) => x.trim());
      const i = count(index);
      if (i === null || i > 64) return [];
      return [
        {
          index: i,
          vendor: 'nvidia',
          name: name ? name.slice(0, 200) : null,
          totalBytes: count(total, MIB),
          usedBytes: count(used, MIB),
        },
      ];
    })
    .slice(0, 16);
}

/**
 * `rocm-smi --showmeminfo vram --showproductname --json`: `{"card0": {"VRAM Total Memory (B)":
 * "…", "VRAM Total Used Memory (B)": "…", "Card series": "…"}, …}`.
 */
export function parseRocmSmi(json: string): GpuMemory[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null) return [];
  return Object.entries(doc as Record<string, unknown>)
    .flatMap(([card, v]): GpuMemory[] => {
      const m = /^card(\d+)$/.exec(card);
      if (!m || typeof v !== 'object' || v === null) return [];
      const f = v as Record<string, unknown>;
      const str = (k: string) => (typeof f[k] === 'string' ? f[k] : undefined);
      const name = str('Card series') ?? str('Card SKU') ?? str('Card model');
      return [
        {
          index: Number(m[1]),
          vendor: 'amd',
          name: name ? name.slice(0, 200) : null,
          totalBytes: count(str('VRAM Total Memory (B)')),
          usedBytes: count(str('VRAM Total Used Memory (B)')),
        },
      ];
    })
    .sort((a, b) => a.index - b.index)
    .slice(0, 16);
}

export function nvidiaSmiProbe(run: CommandRunner = execRunner): VramProbe {
  return {
    source: 'nvidia-smi',
    async read() {
      const r = await run(
        'nvidia-smi',
        ['--query-gpu=index,name,memory.total,memory.used', '--format=csv,noheader,nounits'],
        5_000,
      );
      return r.code === 0 ? parseNvidiaSmi(r.stdout) : [];
    },
  };
}

export function rocmSmiProbe(run: CommandRunner = execRunner): VramProbe {
  return {
    source: 'rocm-smi',
    async read() {
      const r = await run(
        'rocm-smi',
        ['--showmeminfo', 'vram', '--showproductname', '--json'],
        5_000,
      );
      return r.code === 0 ? parseRocmSmi(r.stdout) : [];
    },
  };
}

/** A fixed (or changing) answer, for tests and demos. */
export function fakeVramProbe(gpus: GpuMemory[] | (() => GpuMemory[])): VramProbe {
  return {
    source: 'fake',
    read: () => Promise.resolve(typeof gpus === 'function' ? gpus() : gpus),
  };
}

export const noVramProbe: VramProbe = { source: 'none', read: () => Promise.resolve([]) };

/** The first tool that reports a GPU: nvidia-smi, then rocm-smi; none otherwise. */
export async function detectVramProbe(run: CommandRunner = execRunner): Promise<VramProbe> {
  for (const probe of [nvidiaSmiProbe(run), rocmSmiProbe(run)]) {
    try {
      if ((await probe.read()).length > 0) return probe;
    } catch {
      // not installed or not working: try the next one
    }
  }
  return noVramProbe;
}
