// Shared by the model manager's tests and the M6 gate: a hub-class machine's hardware (as a
// fixed reading, so tests don't depend on the machine they run on), the stand-in Ollama's
// installed models and library, and a core wired to them. Neutral placeholder names only.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';

const GiB = 1024 ** 3;

// The hub for the gate: 20 threads, 32 GB, one 24 GB GPU, plenty of disk, no transcription runtime.
export function hubHardware(over: Record<string, unknown> = {}) {
  return {
    at: '2026-10-30T08:00:00.000Z', platform: 'linux', arch: 'x64', hostname: 'example-hub',
    cpu: { model: 'Example 20-thread CPU', threads: 20 }, ram_bytes: 32 * GiB, ram_free_bytes: 24 * GiB,
    gpus: [{ vendor: 'nvidia', name: 'Example GPU 24GB', vram_bytes: 24 * GiB, vram_free_bytes: 22 * GiB, unified: false }],
    disk: { path: '/', total_bytes: 1000 * GiB, free_bytes: 400 * GiB },
    network: [{ name: 'eth0', mac: '02:00:00:00:00:01', address: '192.0.2.10', netmask: '255.255.255.0', broadcast: '192.0.2.255' }],
    whisper: null, sources: ['test fixture'],
    ...over,
  };
}

// What the stand-in Ollama has installed: a small model for sorting, a deep one, a coder, an
// embedder.
export const INSTALLED = [
  { name: 'example-small:3b', size: 2.0e9, parameter_size: '3.2B', family: 'example', capabilities: ['completion', 'tools'] },
  { name: 'example-mid:8b', size: 5.0e9, parameter_size: '8.0B', family: 'example', capabilities: ['completion', 'tools'] },
  { name: 'example-deep:32b', size: 19.9e9, parameter_size: '32.8B', family: 'example', capabilities: ['completion', 'thinking'] },
  { name: 'example-coder:30b', size: 18.6e9, parameter_size: '30.5B', family: 'example', capabilities: ['completion', 'tools'] },
  { name: 'example-embed', size: 0.27e9, parameter_size: '137M', family: 'example-bert', capabilities: ['embedding'] },
];

// What it can download.
export const LIBRARY = {
  'nomic-embed-text': { size: 0.27e9, layers: 2, parameter_size: '137M', capabilities: ['embedding'] },
  'example-new:7b': { size: 4.4e9, layers: 3, parameter_size: '7B', capabilities: ['completion'] },
  'example-huge:70b': { size: 40e9, layers: 2, parameter_size: '70B', capabilities: ['completion'] },
};

export function hardwareFile(dir: string, over: Record<string, unknown> = {}): string {
  const file = join(dir, 'hardware.json');
  writeFileSync(file, JSON.stringify(hubHardware(over)));
  return file;
}

// A core whose hub Ollama is the stand-in at `ollama`, on the fixed hardware.
export function modelsCore(ollama: string, o: { privacy?: string; hardware?: Record<string, unknown>; secrets?: Record<string, string> } = {}): { core: Core; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'nova-models-'));
  const hw = hubHardware(o.hardware ?? {});
  const core = createCore({
    home, version: '0.1.0', trustedOrigin: () => true, secrets: (n) => o.secrets?.[n] ?? null,
    models: { ollamaUrl: ollama, hardware: async () => hw as never, watchMs: 100, wakePollMs: 50 },
  });
  core.profile.set('privacy', 'default', o.privacy ?? 'local-only', 'settings');
  return { core, home };
}

export const say = (text: string) => [{ role: 'user' as const, content: text }];
