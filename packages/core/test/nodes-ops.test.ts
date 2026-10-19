// Compute-node leftovers on the Hub (FR-126, FR-150; ADR-096): the owner's node policy (quiet
// hours, routing eligibility) in the heartbeat answer and in routing, the VRAM and quiet state a
// heartbeat reports, and the Hub's calls to the node's `/node/v1/services/*`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { buildCapability, generateKeys, newJobToken, signDocument } from '@nova/compute';
import { NovaError } from '@nova/shared';
import { MemoryEventSink, NodeService, type AuditRecord } from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';

let db: NovaDatabase;
let events: MemoryEventSink;
let clock: { now: number };
let audit: AuditRecord[];
let calls: { url: string; method: string; auth: string | null }[];
let answer: (url: string) => { status: number; body: unknown };
let nodes: NodeService;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  events = new MemoryEventSink();
  // 12:00 UTC.
  clock = { now: Date.parse('2026-10-17T12:00:00.000Z') };
  audit = [];
  calls = [];
  answer = () => ({ status: 200, body: {} });
  nodes = new NodeService({
    db,
    secrets: new MemorySecretStore(),
    events,
    now: () => new Date(clock.now),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') });
      const a = answer(url);
      return Promise.resolve(
        new Response(JSON.stringify(a.body), {
          status: a.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
});

afterEach(() => {
  nodes.stop();
  db.close();
});

async function registered(timezone?: string) {
  const { token } = await nodes.createEnrollToken(ACCOUNT);
  const keys = generateKeys();
  const capability: Record<string, unknown> = buildCapability({
    deviceId: 'device-1',
    name: 'desk',
    backendKind: 'ollama',
    models: ['llama3'],
    maxConcurrentJobs: 1,
    hardware: { arch: 'x86_64', cores: 8, ramBytes: 32e9, gpus: [] },
    os: { family: 'linux', version: '6.1' },
    ...(timezone ? { timeZone: timezone } : {}),
  });
  const result = await nodes.register({
    enrollToken: token,
    name: 'desk',
    endpoint: 'http://10.0.0.5:7420',
    publicKey: keys.publicKey,
    capability,
    signature: signDocument(capability, keys.privateKeyPem),
    jobToken: newJobToken(),
    protocolVersions: [1],
  });
  return result;
}

const beat = (credential: string, extra: Record<string, unknown> = {}) =>
  nodes.heartbeat(credential, { load: { running: 0, queued: 0 }, ...extra });

describe('node policy (FR-150)', () => {
  it('answers the default policy, then the owner’s, with every heartbeat', async () => {
    const n = await registered();
    expect(await beat(n.credential)).toEqual({
      ok: true,
      policy: { quietHours: [], timeZone: null, routingEligible: true, revision: 0 },
    });
    const p = await nodes.setPolicy(ACCOUNT, n.nodeId, {
      quietHours: ['22:00-07:00'],
      timeZone: 'Europe/Berlin',
    });
    expect(p).toEqual({
      quietHours: ['22:00-07:00'],
      timeZone: 'Europe/Berlin',
      routingEligible: true,
      revision: 1,
    });
    expect((await beat(n.credential)).policy).toEqual(p);
    // A partial change keeps the rest.
    expect(await nodes.setPolicy(ACCOUNT, n.nodeId, { routingEligible: false })).toMatchObject({
      quietHours: ['22:00-07:00'],
      routingEligible: false,
      revision: 2,
    });
    expect(events.names()).toContain('node.policy.changed');
    expect(audit.filter((a) => a.action === 'node.policy.update').at(-1)?.detail).toMatchObject({
      before: { revision: 1 },
      after: { revision: 2, routingEligible: false },
    });
  });

  it('refuses bad input, other accounts and revoked nodes', async () => {
    const n = await registered();
    await expect(
      nodes.setPolicy(ACCOUNT, n.nodeId, { quietHours: ['25:00-07:00'] }),
    ).rejects.toThrow();
    await expect(
      nodes.setPolicy(ACCOUNT, n.nodeId, { timeZone: 'Mars/Olympus' }),
    ).rejects.toThrow();
    await expect(nodes.setPolicy(ACCOUNT, n.nodeId, { extra: true })).rejects.toThrow();
    await expect(nodes.policy(OTHER, n.nodeId)).rejects.toMatchObject({ code: 'not_found' });
    await nodes.revoke(ACCOUNT, n.nodeId);
    const err = await nodes
      .setPolicy(ACCOUNT, n.nodeId, { routingEligible: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NovaError);
    expect((err as NovaError).code).toBe('conflict');
  });

  it('keeps a node out of routing in its quiet hours or when not eligible', async () => {
    const n = await registered();
    await beat(n.credential);
    expect((await nodes.activeNodes(ACCOUNT)).map((x) => x.id)).toEqual([n.nodeId]);
    // 11:00-13:00 UTC covers 12:00.
    await nodes.setPolicy(ACCOUNT, n.nodeId, { quietHours: ['11:00-13:00'] });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
    expect((await nodes.detail(ACCOUNT, n.nodeId)).quietNow).toBe(true);
    // The same range in Tokyo (UTC+9) is 02:00-04:00 UTC: not now.
    await nodes.setPolicy(ACCOUNT, n.nodeId, { timeZone: 'Asia/Tokyo' });
    expect(await nodes.activeNodes(ACCOUNT)).toHaveLength(1);
    await nodes.setPolicy(ACCOUNT, n.nodeId, { routingEligible: false });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
    await nodes.setPolicy(ACCOUNT, n.nodeId, { routingEligible: true, quietHours: [] });
    expect(await nodes.activeNodes(ACCOUNT)).toHaveLength(1);
    // The node says it is quiet (its own hours): also left out.
    await beat(n.credential, { quiet: true });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
    expect((await nodes.detail(ACCOUNT, n.nodeId)).reportedQuiet).toBe(true);
  });

  it('reads quiet hours in the zone the node declares when the policy names none', async () => {
    const n = await registered('Asia/Tokyo');
    await beat(n.credential);
    // 21:00-22:00 in Tokyo is 12:00-13:00 UTC: now.
    await nodes.setPolicy(ACCOUNT, n.nodeId, { quietHours: ['21:00-22:00'] });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
  });
});

describe('VRAM in heartbeats (FR-126)', () => {
  it('keeps what the node reports and shows it with the node', async () => {
    const n = await registered();
    await beat(n.credential, {
      vram: [{ index: 0, vendor: 'nvidia', name: 'RTX', totalBytes: 8e9, usedBytes: 2e9 }],
    });
    const d = await nodes.detail(ACCOUNT, n.nodeId);
    expect(d).toMatchObject({
      status: 'active',
      vram: [{ index: 0, vendor: 'nvidia', name: 'RTX', totalBytes: 8e9, usedBytes: 2e9 }],
      load: { running: 0, queued: 0 },
      quietNow: false,
    });
    await expect(beat(n.credential, { vram: [{ index: -1 }] })).rejects.toThrow();
  });
});

describe('node services (/node/v1/services/*)', () => {
  it('lists and controls the node’s services with its job token', async () => {
    const n = await registered();
    await beat(n.credential);
    answer = (url) =>
      url.endsWith('/node/v1/services')
        ? {
            status: 200,
            body: {
              services: [
                { name: 'jobs', kind: 'builtin', state: 'running' },
                { name: 'backend', kind: 'systemd', state: 'stopped', unit: 'ollama.service' },
                { name: 'other', kind: 'builtin', state: 'running' },
              ],
            },
          }
        : { status: 200, body: { service: { name: 'jobs', kind: 'builtin', state: 'stopped' } } };
    expect(await nodes.services(ACCOUNT, n.nodeId)).toEqual([
      { name: 'jobs', kind: 'builtin', state: 'running', unit: null },
      { name: 'backend', kind: 'systemd', state: 'stopped', unit: 'ollama.service' },
    ]);
    expect(await nodes.serviceAction(ACCOUNT, n.nodeId, 'jobs', 'stop')).toEqual({
      name: 'jobs',
      kind: 'builtin',
      state: 'stopped',
      unit: null,
    });
    expect(calls.at(-1)).toMatchObject({
      url: 'http://10.0.0.5:7420/node/v1/services/jobs/stop',
      method: 'POST',
    });
    expect(calls.at(-1)!.auth).toMatch(/^Bearer /);
    expect(audit.map((a) => a.action)).toContain('node.service.stop');
    expect(events.names()).toContain('node.service.changed');
    await nodes.serviceAction(ACCOUNT, n.nodeId, 'jobs', 'status');
    expect(audit.filter((a) => a.action.startsWith('node.service.'))).toHaveLength(1);
  });

  it('says why when the node cannot do it', async () => {
    const n = await registered();
    await beat(n.credential);
    answer = (url) =>
      url.endsWith('/node/v1/services')
        ? { status: 404, body: { error: { code: 'not_found', message: 'not found' } } }
        : {
            status: 409,
            body: {
              error: {
                code: 'conflict',
                message: 'not managed',
                details: { reason: 'not_managed' },
              },
            },
          };
    await expect(nodes.services(ACCOUNT, n.nodeId)).rejects.toMatchObject({
      code: 'capability_missing',
      details: { reason: 'update_required' },
    });
    await expect(nodes.serviceAction(ACCOUNT, n.nodeId, 'backend', 'start')).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'not_managed' },
    });
    answer = () => ({ status: 401, body: {} });
    await expect(nodes.serviceAction(ACCOUNT, n.nodeId, 'jobs', 'start')).rejects.toMatchObject({
      code: 'auth_missing',
    });
    // Unreachable and unknown nodes.
    clock.now += 60_000;
    await nodes.sweep();
    await expect(nodes.services(ACCOUNT, n.nodeId)).rejects.toMatchObject({
      code: 'node_unavailable',
    });
    await expect(nodes.services(OTHER, n.nodeId)).rejects.toMatchObject({ code: 'not_found' });
  });
});
