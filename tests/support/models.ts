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

// Wake-on-LAN without a network (the WoL ADR's test plan): a stand-in sender that keeps each packet's
// bytes, target, port and bound address and opens no socket at all, and the hub's own card on the
// example home network 192.168.1.0/24.
export interface WolPacket { bytes: Buffer; host: string; port: number; bind: string | null }
export function wolRecorder(onSend?: (p: WolPacket) => void) {
  const packets: WolPacket[] = [];
  const sender = async (s: { packet: Buffer; host: string; port: number; bind: string | null }) => {
    const p = { bytes: Buffer.from(s.packet), host: s.host, port: s.port, bind: s.bind };
    packets.push(p);
    onSend?.(p);
  };
  return { packets, sender, onSend: (f: (p: WolPacket) => void) => { onSend = f; } };
}
export const HUB_LAN = [{ name: 'eth0', address: '192.168.1.10', netmask: '255.255.255.0' }];
// A paired computer's card on that network, and the loopback address its stand-in Ollama answers at.
export const SPOKE_LAN = { name: 'eth0', mac: '02:00:5e:10:00:42', address: '192.168.1.42', netmask: '255.255.255.0', wol: 'magic' };
export const SPOKE_LOOPBACK = { name: 'lo-test', mac: '02:00:5e:10:00:43', address: '127.0.0.1', netmask: '255.0.0.0' };

// A core whose hub Ollama is the stand-in at `ollama`, on the fixed hardware. Wakes always go to the
// recorder (`wol`), so no test of the model manager can send a real packet.
export function modelsCore(ollama: string, o: { privacy?: string; hardware?: Record<string, unknown>; secrets?: Record<string, string>; hubCards?: { name?: string; address: string; netmask: string }[]; now?: () => Date; models?: { wakePollMs?: number; wakeClock?: { now(): number; sleep(ms: number): Promise<void> }; wakeHealthyMs?: number } } = {}):{ core: Core; home: string; wol: ReturnType<typeof wolRecorder> } {
  const home = mkdtempSync(join(tmpdir(), 'nova-models-'));
  const hw = hubHardware(o.hardware ?? {});
  const wol = wolRecorder();
  const core = createCore({
    home, version: '0.1.0', trustedOrigin: () => true, secrets: (n) => o.secrets?.[n] ?? null, ...(o.now ? { now: o.now } : {}),
    models: { ollamaUrl: ollama, hardware: async () => hw as never, watchMs: 100, wakePollMs: 50, hubCards: () => o.hubCards ?? HUB_LAN, wakeSender: wol.sender, wakeGapMs: 0, ...o.models },
  });
  core.profile.set('privacy', 'default', o.privacy ?? 'local-only', 'settings');
  return { core, home, wol };
}

export const say = (text: string) => [{ role: 'user' as const, content: text }];
