// Enrollment and the running node against a scripted Hub: the registration body is signed and
// schema-valid, heartbeats carry load and models, model changes are re-signed and synced, and a
// revoked node wipes its secrets and stops.
import { createPublicKey, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contracts } from '@nova/contracts';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  ComputeNode,
  canonicalJson,
  enroll,
  loadState,
  startFakeBackend,
  statePath,
  type FakeBackend,
  type RegisterBody,
} from '../src/index.ts';

const TOKEN = `nve_${'t'.repeat(43)}`;

interface FakeHub {
  url: string;
  registered: RegisterBody | null;
  beats: { auth: string; body: { load: unknown; models?: string[] } }[];
  syncs: { capability: Record<string, unknown>; signature: string }[];
  revoked: boolean;
  close(): Promise<void>;
}

function verifies(doc: unknown, signature: string, publicKey: string): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  return verify(null, Buffer.from(canonicalJson(doc)), key, Buffer.from(signature, 'base64url'));
}

async function startFakeHub(): Promise<FakeHub> {
  const hub: FakeHub = {
    url: '',
    registered: null,
    beats: [],
    syncs: [],
    revoked: false,
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/node/v1/register') {
        if (body.enrollToken !== TOKEN)
          return send(401, { error: { code: 'auth_missing', message: 'bad token' } });
        if (!verifies(body.capability, body.signature, body.publicKey))
          return send(403, { error: { code: 'policy_denied', message: 'bad signature' } });
        hub.registered = body;
        return send(201, {
          nodeId: 'node-1',
          credential: 'nvn_cred',
          heartbeatIntervalMs: 10_000,
          protocolVersion: 1,
        });
      }
      const auth = req.headers.authorization ?? '';
      if (hub.revoked || auth !== 'Bearer nvn_cred')
        return send(401, { error: { code: 'auth_missing', message: 'not valid' } });
      if (req.url === '/node/v1/heartbeat') {
        hub.beats.push({ auth, body });
        return send(200, { ok: true });
      }
      if (req.url === '/node/v1/models/sync') {
        if (!verifies(body.capability, body.signature, hub.registered!.publicKey))
          return send(403, { error: { code: 'policy_denied', message: 'bad signature' } });
        hub.syncs.push(body);
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

let dir: string;
let hub: FakeHub;
let backend: FakeBackend;
let node: ComputeNode | null;
const log = () => new Logger({ module: 'test', sinks: [new MemorySink()] });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-compute-node-'));
  hub = await startFakeHub();
  backend = await startFakeBackend({ models: ['llama3'] });
  node = null;
});

afterEach(async () => {
  await node?.stop();
  await hub.close();
  await backend.close();
  rmSync(dir, { recursive: true, force: true });
});

const enrollHere = () =>
  enroll({
    hubUrl: hub.url,
    token: TOKEN,
    backendUrl: backend.url,
    backendKind: 'llamacpp',
    name: 'desk',
    listen: '127.0.0.1:0',
    advertise: 'http://127.0.0.1:7420',
    dataDir: dir,
  });

describe('enroll', () => {
  it('registers a signed, schema-valid capability document and keeps secrets in the state file', async () => {
    const state = await enrollHere();
    const body = hub.registered!;
    expect(body).toMatchObject({
      enrollToken: TOKEN,
      name: 'desk',
      endpoint: 'http://127.0.0.1:7420',
      protocolVersions: [1],
    });
    expect(body.jobToken).toMatch(/^nvj_/);
    expect(contracts().validate('device-capability.json', body.capability).ok).toBe(true);
    expect(body.capability).toMatchObject({
      roles: ['compute'],
      services: { modelsPresent: [{ id: 'llama3' }] },
    });
    expect(state.enrollment).toMatchObject({ nodeId: 'node-1', credential: 'nvn_cred' });
    expect(state.enrollment?.jobToken).toBe(body.jobToken);
    const file = readFileSync(statePath(dir), 'utf8');
    expect(file).toContain('PRIVATE KEY');
    await expect(enrollHere()).rejects.toThrow(/already enrolled/);
  });

  it('refuses a malformed token, a bad Hub URL and an unreachable backend', async () => {
    await expect(
      enroll({ hubUrl: hub.url, token: 'abc', backendUrl: backend.url, dataDir: dir }),
    ).rejects.toThrow(/nve_/);
    await expect(
      enroll({ hubUrl: 'ftp://x', token: TOKEN, backendUrl: backend.url, dataDir: dir }),
    ).rejects.toThrow(/http/);
    await expect(
      enroll({ hubUrl: 'nope', token: TOKEN, backendUrl: backend.url, dataDir: dir }),
    ).rejects.toThrow(/not a URL/);
    await expect(
      enroll({
        hubUrl: hub.url,
        token: TOKEN,
        backendUrl: backend.url,
        listen: ':0',
        dataDir: dir,
      }),
    ).rejects.toThrow(/advertise/);
    await backend.close();
    await expect(enrollHere()).rejects.toThrow(/model backend/);
    expect(loadState(dir)).toBeNull();
  });

  it('surfaces the Hub refusing the token', async () => {
    await expect(
      enroll({
        hubUrl: hub.url,
        token: `nve_${'x'.repeat(43)}`,
        backendUrl: backend.url,
        backendKind: 'llamacpp',
        dataDir: dir,
      }),
    ).rejects.toThrow(/bad token/);
  });
});

describe('running node', () => {
  it('refuses to start before enrollment', async () => {
    await expect(ComputeNode.start({ dataDir: dir, log: log() })).rejects.toThrow(/not enrolled/);
  });

  it('serves the job API with its job token, heartbeats and re-syncs changed models', async () => {
    const state = await enrollHere();
    node = await ComputeNode.start({
      dataDir: dir,
      log: log(),
      listen: { host: '127.0.0.1', port: 0 },
    });
    expect(node.nodeId).toBe('node-1');
    // First beat: the capability is re-signed once (the Hub may have an older list), then a beat.
    expect(hub.syncs).toHaveLength(1);
    expect(hub.beats.at(-1)?.body).toEqual({
      load: { running: 0, queued: 0 },
      models: ['llama3'],
      quiet: false,
    });

    const health = await fetch(`${node.url}/node/v1/health`, {
      headers: { authorization: `Bearer ${state.enrollment!.jobToken}` },
    });
    expect(health.status).toBe(200);
    expect((await fetch(`${node.url}/node/v1/health`)).status).toBe(401);

    await node.beat();
    expect(hub.syncs).toHaveLength(1);
    backend.models.push('qwen3:8b');
    await node.beat();
    expect(hub.syncs).toHaveLength(2);
    expect(hub.syncs[1]?.capability).toMatchObject({
      deviceId: state.deviceId,
      services: { modelsPresent: [{ id: 'llama3' }, { id: 'qwen3:8b' }] },
    });
    expect(hub.beats.at(-1)?.body.models).toEqual(['llama3', 'qwen3:8b']);

    // A backend that stops answering serves nothing until it is back.
    await backend.close();
    await node.beat();
    expect(hub.beats.at(-1)?.body.models).toEqual([]);
    expect(hub.syncs).toHaveLength(2);
  });

  it('keeps serving while the Hub is down', async () => {
    await enrollHere();
    node = await ComputeNode.start({
      dataDir: dir,
      log: log(),
      listen: { host: '127.0.0.1', port: 0 },
      heartbeatIntervalMs: 20,
    });
    await hub.close();
    await node.beat();
    await new Promise((r) => setTimeout(r, 60));
    expect(loadState(dir)?.enrollment).not.toBeNull();
  });

  it('wipes its secrets and stops when the Hub revokes it', async () => {
    const first = await enrollHere();
    node = await ComputeNode.start({
      dataDir: dir,
      log: log(),
      listen: { host: '127.0.0.1', port: 0 },
      heartbeatIntervalMs: 20,
    });
    hub.revoked = true;
    expect(await node.done).toBe('revoked');
    const state = loadState(dir)!;
    expect(state.enrollment).toBeNull();
    expect(state.revokedAt).not.toBeNull();
    expect(readFileSync(statePath(dir), 'utf8')).not.toContain('PRIVATE KEY');
    await expect(ComputeNode.start({ dataDir: dir, log: log() })).rejects.toThrow(/revoked/);
    // Re-enrolling is allowed with a new token and keeps the stable device id.
    hub.revoked = false;
    const again = await enrollHere();
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.enrollment?.publicKey).not.toBe(first.enrollment?.publicKey);
    node = null;
  });
});
