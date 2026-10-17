// NodeService (FR-126, ADR-089): one-use enrollment tokens, signed and schema-valid capability
// documents, a key pinned at registration, heartbeat and sweep transitions, and revocation that
// kills the node's credential and job token. Bodies are built with the compute node's own signing
// code, so the Hub's canonical form is checked against the node's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@nova/security';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  buildCapability,
  canonicalJson as nodeCanonicalJson,
  generateKeys,
  newJobToken,
  signDocument,
  type NodeKeys,
} from '@nova/compute';
import {
  MemoryEventSink,
  NodeService,
  canonicalJson,
  jobTokenRef,
  keyFingerprint,
  negotiateProtocol,
  nodeSecretHash,
  verifyDocument,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';

let db: NovaDatabase;
let secrets: MemorySecretStore;
let events: MemoryEventSink;
let clock: { now: number };
let nodes: NodeService;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  secrets = new MemorySecretStore();
  events = new MemoryEventSink();
  clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  nodes = new NodeService({ db, secrets, events, now: () => new Date(clock.now) });
});

afterEach(() => {
  nodes.stop();
  db.close();
});

interface BodyOptions {
  keys?: NodeKeys;
  models?: string[];
  deviceId?: string;
  edit?: (capability: Record<string, unknown>) => void;
}

function capabilityFor(opts: BodyOptions = {}) {
  const capability: Record<string, unknown> = buildCapability({
    deviceId: opts.deviceId ?? 'device-1',
    name: 'desk',
    backendKind: 'ollama',
    models: opts.models ?? ['llama3', 'qwen3:8b'],
    maxConcurrentJobs: 2,
    hardware: {
      arch: 'x86_64',
      cores: 8,
      ramBytes: 32e9,
      gpus: [
        { vendor: 'nvidia', name: 'A', vramBytes: 8e9 },
        { vendor: 'nvidia', name: 'B', vramBytes: 4e9 },
      ],
    },
    os: { family: 'linux', version: '6.1' },
  });
  opts.edit?.(capability);
  return capability;
}

function registerBody(token: string, opts: BodyOptions = {}) {
  const keys = opts.keys ?? generateKeys();
  const capability = capabilityFor(opts);
  return {
    keys,
    body: {
      enrollToken: token,
      name: 'desk',
      endpoint: 'http://10.0.0.5:7420/',
      publicKey: keys.publicKey,
      capability,
      signature: signDocument(capability, keys.privateKeyPem),
      jobToken: newJobToken(),
      protocolVersions: [1],
    },
  };
}

async function registered(opts: BodyOptions = {}) {
  const { token } = await nodes.createEnrollToken(ACCOUNT);
  const { keys, body } = registerBody(token, opts);
  const result = await nodes.register(body);
  return { keys, body, result };
}

const rows = (sql: string, ...params: string[]) =>
  db.raw.prepare(sql).all(...params) as Record<string, unknown>[];

describe('signatures', () => {
  it('uses the same canonical form as the node and verifies only the signed document', () => {
    const doc = { z: [1, { b: 2, a: null }], a: 'é', u: undefined, t: true };
    expect(canonicalJson(doc)).toBe(nodeCanonicalJson(doc));
    expect(() => canonicalJson({ n: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(TypeError);
    const keys = generateKeys();
    const sig = signDocument(doc, keys.privateKeyPem);
    expect(verifyDocument(doc, sig, keys.publicKey)).toBe(true);
    expect(verifyDocument({ ...doc, t: false }, sig, keys.publicKey)).toBe(false);
    expect(verifyDocument(doc, sig, generateKeys().publicKey)).toBe(false);
    expect(verifyDocument(doc, 'short', keys.publicKey)).toBe(false);
    expect(verifyDocument(doc, sig, 'not-a-key')).toBe(false);
    expect(verifyDocument({ n: Infinity }, sig, keys.publicKey)).toBe(false);
    expect(keyFingerprint(keys.publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('negotiates the highest common protocol version', () => {
    expect(negotiateProtocol([3, 1])).toBe(1);
    expect(() => negotiateProtocol([2, 3])).toThrow(
      expect.objectContaining({ code: 'capability_missing', details: { hub: [1], node: [2, 3] } }),
    );
  });
});

describe('enrollment', () => {
  it('issues a one-use token valid for 15 minutes and stores only its hash', async () => {
    const { token, expiresAt } = await nodes.createEnrollToken(ACCOUNT);
    expect(token).toMatch(/^nve_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - clock.now).toBe(15 * 60 * 1000);
    const [row] = rows('SELECT * FROM add_device_request');
    expect(row).toMatchObject({
      role: 'compute',
      status: 'pending',
      code_hash: nodeSecretHash(token),
    });
    expect(JSON.stringify(rows('SELECT * FROM add_device_request'))).not.toContain(token);
  });

  it('registers a node: device, capability, endpoint, vaulted job token and a hashed credential', async () => {
    const { keys, body, result } = await registered();
    expect(result).toMatchObject({ heartbeatIntervalMs: 10_000, protocolVersion: 1 });
    expect(result.credential).toMatch(/^nvn_[A-Za-z0-9_-]{43}$/);
    const [dev] = rows('SELECT * FROM device WHERE id = ?', result.nodeId);
    expect(dev).toMatchObject({
      account_id: ACCOUNT,
      kind: 'compute',
      status: 'active',
      platform: 'linux',
      public_key: keys.publicKey,
      cert_fingerprint: keyFingerprint(keys.publicKey),
      roles: '["compute"]',
    });
    expect(rows('SELECT url, net FROM transport_endpoint')).toEqual([
      { url: 'http://10.0.0.5:7420', net: 'lan' },
    ]);
    expect(await secrets.get(jobTokenRef(result.nodeId))).toBe(body.jobToken);
    const tokens = rows("SELECT * FROM auth_token WHERE kind = 'device'");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token_hash).toBe(nodeSecretHash(result.credential));
    // Domain-separated: the session lookup hash can never find a node credential.
    expect(tokens[0]?.token_hash).not.toBe(hashToken(result.credential));
    const dump = JSON.stringify(rows('SELECT * FROM device')) + JSON.stringify(tokens);
    expect(dump).not.toContain(result.credential);
    expect(dump).not.toContain(body.jobToken);
    expect(rows('SELECT status FROM add_device_request')).toEqual([{ status: 'approved' }]);
    expect(events.events.find((e) => e.name === 'node.registered')?.payload).toEqual({
      nodeId: result.nodeId,
      name: 'desk',
      models: ['llama3', 'qwen3:8b'],
    });

    const [view] = await nodes.list(ACCOUNT);
    expect(view).toMatchObject({
      id: result.nodeId,
      name: 'desk',
      status: 'active',
      endpoint: 'http://10.0.0.5:7420',
      models: ['llama3', 'qwen3:8b'],
      capabilities: { gpus: 2, vramBytes: 12e9, maxConcurrentJobs: 2 },
      load: null,
      lastSeenAt: new Date(clock.now).toISOString(),
    });
    expect(await nodes.list(OTHER)).toEqual([]);
  });

  it('refuses a used, unknown or expired token', async () => {
    const { token } = await nodes.createEnrollToken(ACCOUNT);
    await nodes.register(registerBody(token).body);
    await expect(nodes.register(registerBody(token).body)).rejects.toMatchObject({
      code: 'auth_missing',
    });
    await expect(nodes.register(registerBody(`nve_${'z'.repeat(43)}`).body)).rejects.toMatchObject({
      code: 'auth_missing',
    });
    const late = await nodes.createEnrollToken(ACCOUNT);
    clock.now += 15 * 60 * 1000 + 1;
    await expect(nodes.register(registerBody(late.token).body)).rejects.toMatchObject({
      code: 'auth_missing',
    });
    await nodes.sweep();
    expect(rows('SELECT status FROM add_device_request ORDER BY created_at')).toEqual([
      { status: 'approved' },
      { status: 'expired' },
    ]);
  });

  it('refuses a bad signature and burns the token', async () => {
    const { token } = await nodes.createEnrollToken(ACCOUNT);
    const { body } = registerBody(token);
    const tampered = { ...body, capability: { ...body.capability, name: 'other' } };
    await expect(nodes.register(tampered)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'bad_signature' },
    });
    expect(rows('SELECT status FROM add_device_request')).toEqual([{ status: 'denied' }]);
    await expect(nodes.register(body)).rejects.toMatchObject({ code: 'auth_missing' });
    expect(rows('SELECT id FROM device')).toEqual([]);
    expect(await secrets.list()).toEqual([]);
  });

  it('refuses a capability document that does not match the schema or the role', async () => {
    const one = await nodes.createEnrollToken(ACCOUNT);
    const invalid = registerBody(one.token, { edit: (c) => (c.surprise = true) }).body;
    await expect(nodes.register(invalid)).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'invalid_capability' },
    });
    const two = await nodes.createEnrollToken(ACCOUNT);
    const client = registerBody(two.token, { edit: (c) => (c.roles = ['client']) }).body;
    await expect(nodes.register(client)).rejects.toMatchObject({ code: 'validation' });
  });

  it('keeps the token when the request is malformed or speaks no common protocol', async () => {
    const { token } = await nodes.createEnrollToken(ACCOUNT);
    const { body } = registerBody(token);
    await expect(nodes.register({ ...body, protocolVersions: [7] })).rejects.toMatchObject({
      code: 'capability_missing',
    });
    await expect(nodes.register({ ...body, endpoint: 'ftp://x' })).rejects.toThrow();
    await expect(nodes.register({ ...body, endpoint: 'http://u:p@x' })).rejects.toThrow();
    await expect(nodes.register({ ...body, jobToken: 'short' })).rejects.toThrow();
    expect((await nodes.register(body)).nodeId).toBeTruthy();
  });

  it('refuses a key that is already registered, even after revocation', async () => {
    const { keys, result } = await registered();
    const { token } = await nodes.createEnrollToken(ACCOUNT);
    await expect(nodes.register(registerBody(token, { keys }).body)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'key_in_use' },
    });
    await nodes.revoke(ACCOUNT, result.nodeId);
    const again = await nodes.createEnrollToken(ACCOUNT);
    await expect(nodes.register(registerBody(again.token, { keys }).body)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('model sync', () => {
  it('accepts a document re-signed by the pinned key and announces the change', async () => {
    const { keys, result } = await registered();
    const capability = capabilityFor({ models: ['llama3', 'mistral'] });
    await nodes.syncModels(result.credential, {
      capability,
      signature: signDocument(capability, keys.privateKeyPem),
    });
    expect((await nodes.list(ACCOUNT))[0]?.models).toEqual(['llama3', 'mistral']);
    expect(events.events.find((e) => e.name === 'node.models.changed')?.payload).toEqual({
      nodeId: result.nodeId,
      models: ['llama3', 'mistral'],
    });
    // The same list again changes nothing.
    await nodes.syncModels(result.credential, {
      capability,
      signature: signDocument(capability, keys.privateKeyPem),
    });
    expect(events.names().filter((n) => n === 'node.models.changed')).toHaveLength(1);
  });

  it('refuses a document signed by another key or naming another device', async () => {
    const { keys, result } = await registered();
    const capability = capabilityFor({ models: ['evil'] });
    await expect(
      nodes.syncModels(result.credential, {
        capability,
        signature: signDocument(capability, generateKeys().privateKeyPem),
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    const moved = capabilityFor({ deviceId: 'device-2' });
    await expect(
      nodes.syncModels(result.credential, {
        capability: moved,
        signature: signDocument(moved, keys.privateKeyPem),
      }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'device_mismatch' } });
    await expect(
      nodes.syncModels('nvn_unknown', { capability, signature: 'x' }),
    ).rejects.toMatchObject({ code: 'auth_missing' });
    expect((await nodes.list(ACCOUNT))[0]?.models).toEqual(['llama3', 'qwen3:8b']);
  });
});

describe('heartbeat and liveness', () => {
  it('records load, marks silent nodes unreachable and brings them back on the next beat', async () => {
    const { result } = await registered();
    const id = result.nodeId;
    await nodes.heartbeat(result.credential, { load: { running: 1, queued: 2 } });
    expect(nodes.load(id)).toEqual({ running: 1, queued: 2 });
    expect((await nodes.list(ACCOUNT))[0]?.load).toEqual({ running: 1, queued: 2 });

    clock.now += 29_000;
    expect(await nodes.sweep()).toEqual([]);
    clock.now += 2_000;
    expect(await nodes.sweep()).toEqual([id]);
    const [view] = await nodes.list(ACCOUNT);
    expect(view).toMatchObject({ status: 'unreachable', load: null });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
    expect(rows('SELECT healthy FROM transport_endpoint')).toEqual([{ healthy: 0 }]);

    await nodes.heartbeat(result.credential, { load: { running: 0, queued: 0 } });
    expect((await nodes.list(ACCOUNT))[0]?.status).toBe('active');
    const changes = events.events
      .filter((e) => e.name === 'node.status.changed')
      .map((e) => e.payload);
    expect(changes).toEqual([
      { nodeId: id, from: 'active', status: 'unreachable' },
      { nodeId: id, from: 'unreachable', status: 'active' },
    ]);
  });

  it('lets an unsigned heartbeat hide models but never add them', async () => {
    const { result } = await registered();
    await nodes.heartbeat(result.credential, {
      load: { running: 0, queued: 0 },
      models: ['qwen3:8b', 'unsigned-extra'],
    });
    expect((await nodes.activeNodes(ACCOUNT))[0]?.models).toEqual(['qwen3:8b']);
  });

  it('refuses unknown credentials and malformed beats', async () => {
    const { result } = await registered();
    await expect(
      nodes.heartbeat('nvn_nope', { load: { running: 0, queued: 0 } }),
    ).rejects.toMatchObject({ code: 'auth_missing' });
    await expect(nodes.heartbeat('nvx_session', {})).rejects.toMatchObject({
      code: 'auth_missing',
    });
    await expect(nodes.heartbeat(result.credential, { load: { running: -1 } })).rejects.toThrow();
  });

  it('sweeps on a timer once started', async () => {
    const quick = new NodeService({
      db,
      secrets,
      events,
      heartbeatIntervalMs: 10,
      missedBeats: 1,
    });
    const { token } = await quick.createEnrollToken(ACCOUNT);
    const result = await quick.register(registerBody(token).body);
    quick.start();
    quick.start();
    await new Promise((r) => setTimeout(r, 60));
    quick.stop();
    expect((await quick.list(ACCOUNT))[0]?.status).toBe('unreachable');
    expect(result.heartbeatIntervalMs).toBe(10);
  });
});

describe('revocation', () => {
  it('kills the credential and job token at once and takes the node out of routing', async () => {
    const { result } = await registered();
    const seen: string[] = [];
    const off = nodes.onRevoked((id) => seen.push(id));
    nodes.onRevoked(() => {
      throw new Error('a failing listener does not stop revocation');
    });
    await nodes.revoke(ACCOUNT, result.nodeId);
    off();
    expect(seen).toEqual([result.nodeId]);
    await expect(
      nodes.heartbeat(result.credential, { load: { running: 0, queued: 0 } }),
    ).rejects.toMatchObject({ code: 'auth_missing' });
    expect(await nodes.authenticate(result.credential)).toBeNull();
    expect(await nodes.jobToken(result.nodeId)).toBeNull();
    expect(rows("SELECT id FROM auth_token WHERE kind = 'device'")).toEqual([]);
    const [view] = await nodes.list(ACCOUNT);
    expect(view).toMatchObject({ status: 'revoked', models: [], load: null });
    expect(await nodes.activeNodes(ACCOUNT)).toEqual([]);
    expect(events.events.at(-1)).toMatchObject({
      name: 'node.status.changed',
      payload: { nodeId: result.nodeId, from: 'active', status: 'revoked' },
    });
    // Idempotent; other accounts and unknown ids are not found.
    await nodes.revoke(ACCOUNT, result.nodeId);
    await expect(nodes.revoke(OTHER, result.nodeId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(nodes.revoke(ACCOUNT, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
