// Compute-node leftovers (FR-126, M7.5): GPU memory through a VRAM probe (nvidia-smi, rocm-smi,
// a fake) in the signed capability document and every heartbeat; quiet hours (the operator's own
// and the owner's policy from the heartbeat answer) refusing new jobs; and the node's managed
// services on `/node/v1/services/*` (the jobs service, a model-server unit through systemctl).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contracts } from '@nova/contracts';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  ComputeNode,
  NodeServices,
  buildCapability,
  detectVramProbe,
  enroll,
  fakeUnitController,
  fakeVramProbe,
  loadState,
  noVramProbe,
  nvidiaSmiProbe,
  parseNvidiaSmi,
  parseQuietHours,
  parseRocmSmi,
  rocmSmiProbe,
  startFakeBackend,
  systemctlController,
  type CommandRunner,
  type FakeBackend,
  type GpuMemory,
} from '../src/index.ts';

const TOKEN = `nve_${'t'.repeat(43)}`;
const GIB = 1024 ** 3;

describe('VRAM probes', () => {
  it('parses nvidia-smi and rocm-smi', () => {
    expect(
      parseNvidiaSmi('0, NVIDIA GeForce RTX 4090, 24564, 1024\n1, Tesla T4, 15360, [N/A]\n\nbad'),
    ).toEqual([
      {
        index: 0,
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        totalBytes: 24564 * 1024 * 1024,
        usedBytes: 1024 * 1024 * 1024,
      },
      {
        index: 1,
        vendor: 'nvidia',
        name: 'Tesla T4',
        totalBytes: 15360 * 1024 * 1024,
        usedBytes: null,
      },
    ]);
    expect(
      parseRocmSmi(
        JSON.stringify({
          card1: { 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '10' },
          card0: {
            'VRAM Total Memory (B)': '8573157376',
            'VRAM Total Used Memory (B)': '268435456',
            'Card series': 'Radeon RX 7600',
          },
          system: { driver: 'x' },
        }),
      ),
    ).toEqual([
      {
        index: 0,
        vendor: 'amd',
        name: 'Radeon RX 7600',
        totalBytes: 8573157376,
        usedBytes: 268435456,
      },
      { index: 1, vendor: 'amd', name: null, totalBytes: 17163091968, usedBytes: 10 },
    ]);
    expect(parseRocmSmi('not json')).toEqual([]);
    expect(parseRocmSmi('null')).toEqual([]);
  });

  it('runs the tools without a shell and picks the first that reports a GPU', async () => {
    const seen: string[] = [];
    const run =
      (answers: Record<string, { code: number | null; stdout: string }>): CommandRunner =>
      (cmd, args) => {
        seen.push([cmd, ...args].join(' '));
        return Promise.resolve(answers[cmd] ?? { code: null, stdout: '' });
      };
    const nv = run({ 'nvidia-smi': { code: 0, stdout: '0, A, 1024, 0' } });
    expect((await detectVramProbe(nv)).source).toBe('nvidia-smi');
    expect(seen[0]).toBe(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv,noheader,nounits',
    );
    const amd = run({
      'nvidia-smi': { code: 127, stdout: '' },
      'rocm-smi': { code: 0, stdout: JSON.stringify({ card0: { 'VRAM Total Memory (B)': '1' } }) },
    });
    expect((await detectVramProbe(amd)).source).toBe('rocm-smi');
    expect(await (await detectVramProbe(run({}))).read()).toEqual([]);
    expect(
      await nvidiaSmiProbe(run({ 'nvidia-smi': { code: 9, stdout: '0, A, 1, 1' } })).read(),
    ).toEqual([]);
    expect(await rocmSmiProbe(run({})).read()).toEqual([]);
    const failing: CommandRunner = () => Promise.reject(new Error('spawn failed'));
    expect((await detectVramProbe(failing)).source).toBe('none');
    expect(await noVramProbe.read()).toEqual([]);
  });

  it('puts total VRAM, the zone and the quiet hours into a schema-valid document', () => {
    const doc = buildCapability({
      deviceId: 'd1',
      name: 'gpu box',
      backendKind: 'ollama',
      models: ['llama3'],
      maxConcurrentJobs: 1,
      hardware: { arch: 'x86_64', cores: 8, ramBytes: 32 * GIB, gpus: [{ vendor: 'nvidia' }] },
      os: { family: 'linux', version: '6.1' },
      vram: [{ vendor: 'nvidia', name: 'RTX', totalBytes: 24 * GIB }],
      timeZone: 'Europe/Berlin',
      quietHours: ['22:00-07:00'],
    });
    expect(doc.hardware).toMatchObject({
      gpus: [{ vendor: 'nvidia', name: 'RTX', vramBytes: 24 * GIB }],
    });
    expect(doc.locale).toEqual({ timezone: 'Europe/Berlin' });
    expect(doc.scheduling).toEqual({ quietHours: ['22:00-07:00'] });
    expect(contracts().validate('device-capability.json', doc).ok).toBe(true);
  });
});

describe('the node’s services', () => {
  it('stops and starts the jobs service, and manages the backend unit only when named', async () => {
    let stopped = false;
    let cancelled = 0;
    const jobs = {
      stopped: () => stopped,
      setStopped: (v: boolean) => {
        stopped = v;
      },
      cancelAll: () => {
        cancelled++;
      },
    };
    const units = fakeUnitController({ 'ollama.service': 'running' });
    const s = new NodeServices({ jobs, backendUnit: 'ollama.service', units });
    expect(await s.list()).toEqual([
      { name: 'jobs', kind: 'builtin', state: 'running', unit: null },
      { name: 'backend', kind: 'systemd', state: 'running', unit: 'ollama.service' },
    ]);
    expect((await s.act('jobs', 'stop')).state).toBe('stopped');
    expect((await s.act('jobs', 'restart')).state).toBe('running');
    expect(cancelled).toBe(1);
    expect((await s.act('backend', 'stop')).state).toBe('stopped');
    expect((await s.act('backend', 'status')).state).toBe('stopped');
    expect(units.calls).toEqual(['stop ollama.service']);
    await expect(s.act('sshd', 'stop')).rejects.toMatchObject({ code: 'not_found' });
    const none = new NodeServices({ jobs, backendUnit: null, units });
    expect(await none.list()).toHaveLength(1);
    await expect(none.act('backend', 'start')).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'not_managed' },
    });
    expect(() => new NodeServices({ jobs, backendUnit: '--now', units })).toThrow(/unit/);
  });

  it('drives systemd units through systemctl without a shell', async () => {
    const seen: string[][] = [];
    const run: CommandRunner = (cmd, args) => {
      seen.push([cmd, ...args]);
      if (args[0] === 'is-active') return Promise.resolve({ code: 3, stdout: 'inactive\n' });
      return Promise.resolve({ code: args[0] === 'restart' ? 1 : 0, stdout: '' });
    };
    const c = systemctlController(run);
    expect(await c.status('ollama.service')).toBe('stopped');
    await c.act('ollama.service', 'start');
    await expect(c.act('ollama.service', 'restart')).rejects.toMatchObject({
      details: { reason: 'unit_failed' },
    });
    expect(seen).toEqual([
      ['systemctl', 'is-active', '--', 'ollama.service'],
      ['systemctl', 'start', '--', 'ollama.service'],
      ['systemctl', 'restart', '--', 'ollama.service'],
    ]);
    const odd: CommandRunner = () => Promise.resolve({ code: 0, stdout: 'activating' });
    expect(await systemctlController(odd).status('x.service')).toBe('unknown');
  });

  it('checks quiet-hour ranges', () => {
    expect(parseQuietHours('22:00-07:00, 12:00-13:00')).toEqual(['22:00-07:00', '12:00-13:00']);
    expect(parseQuietHours([])).toEqual([]);
    expect(() => parseQuietHours('25:00-07:00')).toThrow(/quiet hours/);
    expect(() => parseQuietHours(Array.from({ length: 11 }, () => '01:00-02:00'))).toThrow(/10/);
  });
});

// ---- a running node against a scripted Hub ---------------------------------------------------

interface Beat {
  load: unknown;
  models?: string[];
  vram?: GpuMemory[];
  quiet?: boolean;
}

interface Hub {
  url: string;
  beats: Beat[];
  syncs: { capability: Record<string, unknown> }[];
  registered: { capability: Record<string, unknown> } | null;
  policy: Record<string, unknown> | null;
  close(): Promise<void>;
}

async function startHub(): Promise<Hub> {
  const hub: Hub = {
    url: '',
    beats: [],
    syncs: [],
    registered: null,
    policy: null,
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/node/v1/register') {
        hub.registered = body as Hub['registered'];
        return send(201, {
          nodeId: 'node-1',
          credential: 'nvn_cred',
          heartbeatIntervalMs: 10_000,
          protocolVersion: 1,
        });
      }
      if (req.url === '/node/v1/heartbeat') {
        hub.beats.push(body as unknown as Beat);
        return send(200, { ok: true, ...(hub.policy ? { policy: hub.policy } : {}) });
      }
      if (req.url === '/node/v1/models/sync') {
        hub.syncs.push(body as Hub['syncs'][number]);
        return send(200, { ok: true });
      }
      send(404, { error: { code: 'not_found', message: 'no' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hub.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return hub;
}

describe('a node with VRAM, quiet hours and services', () => {
  let dir: string;
  let hub: Hub;
  let backend: FakeBackend;
  let node: ComputeNode | null;
  let clock: { now: number };
  let used: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-compute-m75-'));
    hub = await startHub();
    backend = await startFakeBackend({ models: ['llama3'] });
    node = null;
    // 12:00 UTC.
    clock = { now: Date.parse('2026-10-17T12:00:00.000Z') };
    used = GIB;
  });

  afterEach(async () => {
    await node?.stop();
    await hub.close();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const probe = () =>
    fakeVramProbe(() => [
      { index: 0, vendor: 'nvidia', name: 'RTX', totalBytes: 24 * GIB, usedBytes: used },
    ]);

  const start = async (extra: { quietHours?: string[]; backendUnit?: string } = {}) => {
    await enroll({
      hubUrl: hub.url,
      token: TOKEN,
      backendUrl: backend.url,
      backendKind: 'llamacpp',
      name: 'gpu',
      listen: '127.0.0.1:0',
      advertise: 'http://127.0.0.1:7420',
      dataDir: dir,
      vram: probe(),
      timeZone: 'UTC',
      ...extra,
    });
    const units = fakeUnitController({ 'llama.service': 'running' });
    node = await ComputeNode.start({
      dataDir: dir,
      listen: { host: '127.0.0.1', port: 0 },
      heartbeatIntervalMs: 60_000,
      log: new Logger({ module: 'test', sinks: [new MemorySink()] }),
      vram: probe(),
      units,
      now: () => new Date(clock.now),
      timeZone: 'UTC',
    });
    return { units, jobToken: loadState(dir)!.enrollment!.jobToken };
  };

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${node!.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const job = {
    kind: 'chat',
    request: {
      model: 'llama3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    },
  };

  it('reports VRAM in the document and every heartbeat', async () => {
    await start();
    expect(hub.registered!.capability.hardware).toMatchObject({
      gpus: [{ vendor: 'nvidia', name: 'RTX', vramBytes: 24 * GIB }],
    });
    expect(hub.beats.at(-1)).toMatchObject({
      vram: [{ index: 0, totalBytes: 24 * GIB, usedBytes: GIB }],
      quiet: false,
    });
    used = 2 * GIB;
    await node!.beat();
    expect(hub.beats.at(-1)!.vram![0]!.usedBytes).toBe(2 * GIB);
    // Use changes do not re-sign the document; it was synced once.
    expect(hub.syncs).toHaveLength(1);
  });

  it('refuses new jobs in its own quiet hours and in the owner’s, and keeps the policy', async () => {
    const { jobToken } = await start({ quietHours: ['11:00-13:00'] });
    expect(hub.registered!.capability.scheduling).toEqual({ quietHours: ['11:00-13:00'] });
    let r = await call('POST', '/node/v1/jobs', jobToken, job);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { details: unknown } }).error.details).toEqual({
      reason: 'quiet_hours',
    });
    expect(hub.beats.at(-1)!.quiet).toBe(true);
    clock.now += 2 * 3_600_000; // 14:00
    r = await call('POST', '/node/v1/jobs', jobToken, job);
    expect(r.status).toBe(201);
    // The owner's policy arrives with a heartbeat answer and holds across restarts.
    hub.policy = {
      quietHours: ['13:30-15:00'],
      timeZone: null,
      routingEligible: true,
      revision: 1,
    };
    await node!.beat();
    expect(node!.hubPolicy).toEqual(hub.policy);
    expect(loadState(dir)!.hubPolicy).toEqual(hub.policy);
    r = await call('POST', '/node/v1/jobs', jobToken, job);
    expect(r.status).toBe(503);
    // In Tokyo 13:30-15:00 is 04:30-06:00 UTC: not now.
    hub.policy = { ...hub.policy, timeZone: 'Asia/Tokyo', revision: 2 };
    await node!.beat();
    expect(node!.quietNow()).toBe(false);
  });

  it('serves its services to the Hub with the job token only', async () => {
    const { jobToken, units } = await start({ backendUnit: 'llama.service' });
    expect((await call('GET', '/node/v1/services', 'wrong')).status).toBe(401);
    let r = await call('GET', '/node/v1/services', jobToken);
    expect(await r.json()).toEqual({
      services: [
        { name: 'jobs', kind: 'builtin', state: 'running', unit: null },
        { name: 'backend', kind: 'systemd', state: 'running', unit: 'llama.service' },
      ],
    });
    r = await call('POST', '/node/v1/services/jobs/stop', jobToken, {});
    expect(((await r.json()) as { service: { state: string } }).service.state).toBe('stopped');
    r = await call('POST', '/node/v1/jobs', jobToken, job);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { details: unknown } }).error.details).toEqual({
      reason: 'jobs_stopped',
    });
    expect(loadState(dir)!.jobsStopped).toBe(true);
    await call('POST', '/node/v1/services/jobs/start', jobToken, {});
    expect((await call('POST', '/node/v1/jobs', jobToken, job)).status).toBe(201);
    r = await call('POST', '/node/v1/services/backend/restart', jobToken, {});
    expect(r.status).toBe(200);
    expect(units.calls).toEqual(['restart llama.service']);
    expect((await call('POST', '/node/v1/services/sshd/stop', jobToken, {})).status).toBe(404);
    expect((await call('POST', '/node/v1/services/jobs/kill', jobToken, {})).status).toBe(400);
  });

  it('refuses a bad unit name or quiet hours at enrollment', async () => {
    await expect(
      enroll({
        hubUrl: hub.url,
        token: TOKEN,
        backendUrl: backend.url,
        backendKind: 'llamacpp',
        listen: '127.0.0.1:0',
        advertise: 'http://127.0.0.1:7420',
        dataDir: dir,
        backendUnit: '-x',
      }),
    ).rejects.toThrow(/unit/);
    await expect(
      enroll({
        hubUrl: hub.url,
        token: TOKEN,
        backendUrl: backend.url,
        backendKind: 'llamacpp',
        listen: '127.0.0.1:0',
        advertise: 'http://127.0.0.1:7420',
        dataDir: dir,
        quietHours: ['7-9'],
      }),
    ).rejects.toThrow(/quiet hours/);
  });
});
