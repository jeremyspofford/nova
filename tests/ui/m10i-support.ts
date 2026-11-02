// Synthetic, loopback-only app fixture. The browser uses the real static server, core API,
// access rules and field validation. Only the privileged supervisor boundary is controlled.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { generateDeviceKeys, sessionMessage, signMessage } from '../../src/core/index.ts';
import type { HubServiceRequest, SupervisorState } from '../../src/core/resilience/link.ts';
import type { ServiceStatus } from '../../src/core/services/driver.ts';
import type { ClusterObservation } from '../../src/core/services/topology.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { hubHardware } from '../support/models.ts';
import type { Hardware } from '../../src/core/models/hardware.ts';
import { finishSetup } from './support.ts';

export async function topologyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nova-m10i-app-'));
  const controls = { oldService: false, serviceAgeMs: 1000, partial: false, long: false, refusal: false, extraReady: false, conflict: false, policy: 2 as 2|3, candidate: '2.0.0', calls: [] as HubServiceRequest[] };
  let captureDeviceId: string | null = null;
  const at = () => new Date(Date.now() - 1000).toISOString();
  const old = () => new Date(Date.now() - 18 * 60_000).toISOString();
  function service(name: string): ServiceStatus {
    return { service: name, driver: 'supervisor', live: '1.0.0', previous: '0.9.0', soak_until: null, held: null, health: { ok: true, checked_at: controls.oldService ? old() : new Date(Date.now() - controls.serviceAgeMs).toISOString(), said: null }, stable: {}, history: [], versions: [
      { version: '1.0.0', status: 'live', since: at(), said: null, ports: null, pid: null },
      { version: controls.candidate, status: 'ready', since: at(), said: null, ports: null, pid: null },
      ...(controls.extraReady && name === 'ordinary' ? [{ version: '2.1.0', status: 'ready' as const, since: at(), said: null, ports: null, pid: null }] : []),
      { version: '0.9.0', status: 'kept', since: at(), said: null, ports: null, pid: null },
    ] };
  }
  const state = (): SupervisorState => ({ v: 1, pid: 1, mode: 'running', since: at(), server: { pid: 2, port: 0, started_at: at(), restarts: 0, last_exit: null, code: 'fixture' }, safe_mode: null, health: { last_check_at: at(), last_ok_at: at(), failing: 0, said: null }, releases: { current: '1.0.0', previous: '0.9.0', last_good: '1.0.0', slots: [] }, deploy: null, history: [], observed_at: at(), services: ['ordinary', 'capture-demo', 'privileged'].map(service), service_policies: [{ service: 'ordinary', version: '2.1.0', promotion_tier: 3 }, ...['ordinary', 'capture-demo', 'privileged'].map(service => ({ service, version: controls.candidate, promotion_tier: service === 'ordinary' ? controls.policy : 3 }))] });
  const supervisor = {
    state,
    request: async () => { throw new Error('Unexpected generic supervisor request'); },
    async service(r: HubServiceRequest) {
      assert.ok(['ordinary', 'capture-demo', 'privileged'].includes(r.service), `Unexpected service ${r.service}`);
      if (r.action === 'promote') assert.ok(r.version === controls.candidate || (controls.extraReady && r.service === 'ordinary' && r.version === '2.1.0'), 'Unexpected promotion version');
      assert.deepEqual(r, r.action === 'promote' ? { action: 'promote', service: r.service, version: r.version, confirm: `${r.service}@${r.version}` } : { action: 'rollback', service: r.service, confirm: 'rollback' });
      controls.calls.push(r);
      return controls.refusal ? { ok: false, said: 'The target is no longer ready.' } : { ok: true, accepted: true, said: 'The change was accepted; this does not confirm that the version is serving.' };
    },
    onProblem() {},
  };
  // File keys are confined to this synthetic home; no host keychain is consulted.
  const before = process.env.NOVA_VAULT_KEY;
  process.env.NOVA_VAULT_KEY = 'file';
  const config = { ...loadConfig({ NOVA_HOME: join(dir, 'home'), NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC', NOVA_MESH_URL: 'http://127.0.0.1:0', NOVA_MESH_TRANSPORT: 'network' }), port: 0 };
  const runtime = await startFakeOllama({ models: [] });
  let nova: ReturnType<typeof createNova>;
  try { nova = createNova(config, { supervisor, secrets: () => null, models: { ollamaUrl: runtime.url, hardware: async () => hubHardware() as Hardware }, topologyCluster: (): ClusterObservation => {
    if (controls.partial) throw new Error('fixture unavailable');
    return { machines: [{ id: 'synthetic-site', name: controls.long ? 'A synthetic cloud site with an exceptionally long descriptive name '.repeat(3) : 'Synthetic site', kind: 'cloud', roles: ['read-only observation'], observation: { health: 'unknown', at: at(), reason: 'No workload health observation is available.' }, services: [] }, ...(controls.conflict && captureDeviceId ? [{ id: captureDeviceId, name: 'Synthetic capture desktop', kind: 'machine' as const, roles: ['worker'], observation: { health: 'failed' as const, at: at(), reason: 'Synthetic cluster reports the node stopped.' }, services: [] }] : [])] };
  } }); } finally { if (before === undefined) delete process.env.NOVA_VAULT_KEY; else process.env.NOVA_VAULT_KEY = before; }
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  await new Promise<void>(r => nova.mesh!.listen(0, '127.0.0.1', r));
  const meshBase = `http://127.0.0.1:${(nova.mesh!.address() as AddressInfo).port}`;
  nova.meshInfo!.publicUrl = meshBase;
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  await finishSetup({ send } as Parameters<typeof finishSetup>[0]);
  const keys = generateDeviceKeys();
  const device = nova.core.mesh.devices.add({ name: 'Synthetic capture desktop', platform: 'linux x64', kind: 'computer', public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat'], purposes: ['general-server', 'capture-source'] }, 'fixture');
  captureDeviceId = device.id;
  nova.core.mesh.devices.touch(device.id);
  nova.core.db.run('INSERT INTO capture_device_sync (device_id, acked_seq, synced_to, queued, paused, at) VALUES (?, 0, ?, 17, ?, ?)', device.id, old(), 'Synthetic source is paused', old());
  return { base, meshBase, nova, controls, deviceId: device.id, hubId: nova.core.mesh.identity.id, send,
    readOnlyToken() {
      const k = generateDeviceKeys();
      const reader = nova.core.mesh.devices.add({ name: 'Synthetic read-only browser', platform: 'test', kind: 'browser', public_key: k.ed25519.publicKey, x25519_public_key: k.x25519.publicKey, capabilities: [] }, 'fixture');
      const t = Math.floor(Date.now() / 1000);
      return nova.core.mesh.devices.startSession({ device_id: reader.id, time: t, signature: signMessage(k.ed25519.privateKey, sessionMessage(reader.id, t)) }).token;
    },
    async close() { nova.server.closeAllConnections(); nova.server.close(); nova.mesh!.closeAllConnections(); nova.mesh!.close(); await nova.core.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
