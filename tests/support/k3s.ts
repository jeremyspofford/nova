import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { ClusterCapacityError, K3sDriver, k3sDeviceLabel, type K3sClock, type ClusterTools, type ClusterOperation, type ClusterSnapshot, type K3sCluster, type ServiceDefinition } from '../../src/core/index.ts';
export class SimulationClock implements K3sClock {
  time = Date.parse('2026-11-02T12:00:00.000Z');
  onSleep: (() => void | Promise<void>) | null = null;
  timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.time;
  advance(ms: number) { this.time += ms; }
  async sleep(ms: number, signal: AbortSignal) { signal.throwIfAborted(); this.advance(ms); await this.onSleep?.(); signal.throwIfAborted(); }
  schedule(callback: () => void, ms: number) { const timer = { at: this.time + ms, callback }; this.timers.add(timer); return () => { this.timers.delete(timer); }; }
  fire() { for (const timer of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(timer); timer.callback(); } }
}
export interface SimulationState {
  cluster: string; namespace: string; reachable: boolean;
  nodes: { healthy: boolean; labels: Record<string, string> }[];
  services: Record<string, ClusterSnapshot>;
  unhealthy: string[]; unknown: string[];
  calls: { tool: string; operation: string; argv: string[] }[];
  statusOverride?: unknown;
}
export async function simulatedK3s() {
  const home = mkdtempSync(join(tmpdir(), 'nova-k3s-simulation-'));
  const directory = join(home, 'definitions');
  const bin = join(home, 'bin'); mkdirSync(bin);
  const stateFile = join(home, 'cluster.json');
  const clock = new SimulationClock();
  const cluster: K3sCluster = { id: 'simulation', namespace: 'nova-services', hubId: 'linux', devices: [
    { id: 'linux', name: 'Linux', kind: 'computer', role: 'hub', platform: 'linux x64', purposes: ['general-server'], trust: 'trusted', healthy: true, last_seen: null, hardware: { ram_bytes: 8 * 1024 ** 3, gpus: [], disk: { free_bytes: 20 * 1024 ** 3 }, platform: 'linux', arch: 'x64' } },
    { id: 'windows', name: 'Windows', kind: 'computer', role: 'spoke', platform: 'win32 x64', purposes: ['general-server'], trust: 'trusted', healthy: true, last_seen: null, hardware: null },
  ] };
  const state: SimulationState = { cluster: cluster.id, namespace: cluster.namespace, reachable: true, services: {}, unhealthy: [], unknown: [], calls: [], nodes: [{ healthy: true, labels: { 'kubernetes.io/os': 'linux', 'nova/device': k3sDeviceLabel('linux'), 'nova/role-general-server': 'true', 'nova/memory-gb': '8', 'nova/disk-gb': '20', 'nova/gpu-vram-gb': '0' } }] };
  writeFileSync(stateFile, JSON.stringify(state));
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const tool of ['kubectl', 'helm', 'flux']) symlinkSync(resolve(import.meta.dirname, `../../scripts/stand-ins/fake-${tool}.js`), join(bin, tool));
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8')) as SimulationState;
  const change = (fn: (s: SimulationState) => void) => { const s = read(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
  const transcript: { tool: string; argv: string[]; stdout: string; stderr: string; exit: number | null }[] = [];
  const raw = (tool: string, operation: ClusterOperation, signal?: AbortSignal): Promise<unknown> => new Promise((resolveResult, reject) => {
    // This helper is test-only. PATH contains only this fixture's committed fake symlinks + node.
    const child = spawn(tool, ['nova-simulation', operation.operation, '--namespace', operation.namespace, '--service', operation.service], { cwd: home, env: { PATH: bin, HOME: home, NOVA_SIM_STATE: stateFile, NOVA_SIM_NOW: String(clock.now()) }, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let out = ''; let err = ''; let total = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.stdout.on('data', chunk => { total += chunk.length; if (total > 262144) child.kill('SIGKILL'); else out += chunk; });
    child.stderr.on('data', chunk => { total += chunk.length; if (total > 262144) child.kill('SIGKILL'); else err += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); transcript.push({ tool, argv: ['nova-simulation', operation.operation, '--namespace', operation.namespace, '--service', operation.service], stdout: out, stderr: err, exit: code }); if (code === 73 && err === 'Simulation version capacity reached before effects.\n') reject(new ClusterCapacityError()); else if (code !== 0) reject(new Error(`Fake child failed (${code}): ${err}`)); else { try { resolveResult(JSON.parse(out)); } catch { reject(new Error('Invalid child JSON.')); } } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(operation));
  });
  const tools: ClusterTools = {
    available: () => ({ ok: true, said: 'Explicit test-only simulation port.' }),
    execute: async (op, signal) => {
      if (op.operation === 'prepare' || op.operation === 'prepare-workload') await raw('helm', op, signal);
      if (op.operation === 'status') await raw('flux', op, signal);
      return await raw('kubectl', op, signal) as ClusterSnapshot;
    },
  };
  const server = createServer((req, res) => {
    const s = read(); const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/stable') {
      const row = s.services.echo; const live = row?.versions.find(v => v.version === row.live);
      res.end(JSON.stringify({ version: live && live.replicas > 0 && !s.unhealthy.includes(live.version) ? live.version : null })); return;
    }
    const match = /^\/preview\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    const version = match && s.services[decodeURIComponent(match[1]!)]?.versions.find(v => v.version === decodeURIComponent(match[2]!));
    if (!version || !version.replicas || s.unhealthy.includes(version.version) || match?.[3] === '/fail-contract') { res.writeHead(503); res.end('unhealthy'); return; }
    if (match?.[3] === '/redirect') { res.writeHead(302, { location: '/stable' }); res.end(); return; }
    res.end(JSON.stringify({ version: version.version }));
  });
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const options = { cluster, directory, tools, clock, probeOrigin: origin, authorizeNetwork: async () => ({ ok: true, said: 'Explicit fixture-only network policy authorization; no real network change.' }) };
  const driver = new K3sDriver(options);
  const drivers = [driver];
  return {
    home, bin, directory, clock, cluster, driver, tools, raw, read, change, origin, options, transcript,
    another: () => { const next = new K3sDriver(options); drivers.push(next); return next; },
    calls: () => read().calls,
    definition: (version: string, o: { failContract?: boolean } = {}): ServiceDefinition => ({ service: 'echo', version, artifact: { image: `example/echo@sha256:${'a'.repeat(64)}` }, ports: [{ name: 'http', port: 18080 }], health: { http: '/health', every_s: 5 }, contract_tests: [o.failContract ? 'http:/fail-contract' : 'http:/contract'], alongside: 'full', placement: { mode: 'pinned', device: 'hub' }, secrets: [], egress: 'none', os_permissions: [] }),
    serving: async (): Promise<string | null> => { const res = await fetch(`${origin}/stable`); return (await res.json() as { version: string | null }).version; },
    close: async () => { for (const d of drivers) await d.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(home, { recursive: true, force: true }); },
  };
}
