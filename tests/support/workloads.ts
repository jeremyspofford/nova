// Helpers for the native-workload tests (M10h): the stand-in Screenpipe as an artifact, manifests the
// test signs itself (with a pinned key or not: the test decides), and free loopback ports. Neutral
// placeholders only; nothing real is installed anywhere.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex, signMessage, workloadManifestMessage, type DeviceKeys, type SignedWorkload, type WorkloadManifest } from '../../src/core/index.ts';

export const STAND_IN = join(import.meta.dirname, '../../scripts/stand-ins/stand-in-screenpipe.js');
export const STAND_IN_NAME = 'stand-in-screenpipe.js';
export const standInBytes = () => readFileSync(STAND_IN);
export const standInSha = () => sha256Hex(standInBytes());
export const standInUrl = () => pathToFileURL(STAND_IN).href;

// A port for an address that must be known before its program starts (a workload's, which is in the
// manifest the hub signs; a standby's, which goes in the roster when it enrolls). Picked below the
// ephemeral range (Linux 32768+ by default, 54175+ on this WSL host; macOS 49152+), never by
// listening on port 0: a port 0 pick lies in that range, and once it is let go any server on port 0
// in a parallel test can be handed it before the program binds it (the M10h pilot's stand-in found
// its port taken that way, and the device agent stopped after three failed starts). Servers that
// can, listen on port 0 themselves and say which port they got.
export async function freePort(host = '127.0.0.1'): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const s = createServer();
    const ok = await new Promise<boolean>((r) => { s.once('error', () => r(false)); s.listen(port, host, () => r(true)); });
    if (ok) {
      await new Promise((r) => s.close(r));
      return port;
    }
  }
}

export function manifest(o: Partial<WorkloadManifest> & { device_id: string; port: number }): WorkloadManifest {
  const { port, ...rest } = o;
  return {
    v: 1, service: 'stand-in', version: '1.0.0', platform: `${process.platform}-${process.arch}`,
    files: { [STAND_IN_NAME]: standInSha() }, command: ['node', STAND_IN_NAME],
    ports: [{ name: 'api', port }], health: { http: '/health', every_s: 5 }, alongside: 'none', roles: ['general-server'],
    capture: null, os_permissions: [], epoch: 1, issued_at: '2026-11-01T10:00:00.000Z',
    ...rest,
  };
}

export function sign(m: WorkloadManifest, keys: DeviceKeys): SignedWorkload {
  return { manifest: m, signature: signMessage(keys.ed25519.privateKey, workloadManifestMessage(m)), signer: keys.ed25519.publicKey };
}

export async function getJson(url: string): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}

// Whether the stand-in answers on this port (another program on this machine may hold a port that
// nothing of the test's is using, so "nothing listens" isn't asked: only "not the stand-in").
export async function standInAt(port: number): Promise<boolean> {
  const h = await getJson(`http://127.0.0.1:${port}/health`);
  return typeof h.body?.frame_status === 'string';
}

export async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
