// Compute node routes end to end (FR-126, FR-127): the owner creates an enrollment token, a real
// compute node (services/compute) enrolls over HTTP against a listening Hub, its models appear,
// a chat turn runs on it and can be cancelled, a node credential never authenticates as a user,
// and revocation cuts the node off.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect, type ChatRequest, type StreamEvent } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { NodeModelSource, type NodeService } from '@nova/core';
import { ComputeNode, enroll, startFakeBackend, type FakeBackend } from '@nova/compute';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let nodes: NodeService;
let source: NodeModelSource;
let backend: FakeBackend;
let hubUrl: string;
let node: ComputeNode | null;
let cookie: string;

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-nodes-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const secrets = new MemorySecretStore();
  const events = new EventStore(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets,
    events,
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  // The Hub wires its own NodeService into the full router; a second source reads the same nodes.
  nodes = hub.nodes;
  source = new NodeModelSource({ nodes });
  hubUrl = await hub.app.listen({ port: 0, host: '127.0.0.1' });
  backend = await startFakeBackend({ models: ['llama3'] });
  node = null;

  const code = await hub.auth.issueSetupCode();
  const res = await fetch(`${hubUrl}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(res.status).toBe(200);
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  cookie = set.split(';')[0]!;
});

afterEach(async () => {
  await node?.stop();
  await hub.app.close();
  await backend.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { cookie },
) {
  const res = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function enrollNode(): Promise<string> {
  const start = await api('POST', '/api/v1/devices/add/start', { role: 'compute' });
  expect(start.status).toBe(201);
  expect(start.json.token).toMatch(/^nve_/);
  const nodeDir = join(dir, 'node');
  const state = await enroll({
    hubUrl,
    token: start.json.token,
    backendUrl: backend.url,
    backendKind: 'llamacpp',
    name: 'gpu-box',
    listen: `127.0.0.1:${await freePort()}`,
    dataDir: nodeDir,
  });
  node = await ComputeNode.start({
    dataDir: nodeDir,
    log: new Logger({ module: 'node', sinks: [new MemorySink()] }),
    heartbeatIntervalMs: 60_000,
  });
  return state.enrollment!.nodeId;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('owner routes', () => {
  it('require a session and support only compute nodes in M2', async () => {
    const anon = { 'x-none': '1' };
    expect((await api('POST', '/api/v1/devices/add/start', { role: 'compute' }, anon)).status).toBe(
      401,
    );
    expect((await api('GET', '/api/v1/devices', undefined, anon)).status).toBe(401);
    expect((await api('POST', '/api/v1/devices/x/revoke', undefined, anon)).status).toBe(401);
    const client = await api('POST', '/api/v1/devices/add/start', { role: 'client' });
    expect(client.status).toBe(400);
    expect(client.json.error).toMatchObject({
      code: 'validation',
      details: { reason: 'role_unsupported' },
    });
    expect((await api('POST', '/api/v1/devices/add/start', { role: 'toaster' })).status).toBe(400);
    expect((await api('GET', '/api/v1/devices')).json).toEqual({ items: [] });
    expect((await api('GET', '/api/v1/devices?role=client')).json).toEqual({ items: [] });
    expect((await api('POST', '/api/v1/devices/nope/revoke')).status).toBe(404);
  });
});

describe('node routes', () => {
  it('validate the body and the credential themselves', async () => {
    expect((await api('POST', '/node/v1/register', { enrollToken: 'x' }, {})).status).toBe(400);
    const beat = { load: { running: 0, queued: 0 } };
    const none = await api('POST', '/node/v1/heartbeat', beat, {});
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe('token_required');
    // A session is not a node credential.
    expect((await api('POST', '/node/v1/heartbeat', beat, { cookie })).status).toBe(401);
    const session = cookie.split('=')[1]!;
    expect(
      (await api('POST', '/node/v1/models/sync', {}, { authorization: `Bearer ${session}` }))
        .status,
    ).toBe(401);
  });
});

describe('a compute node end to end', () => {
  it('enrolls, lists, runs a chat turn, cancels, and is revoked', async () => {
    const nodeId = await enrollNode();

    // Listed with its models and load (the node sent its first heartbeat on start).
    const listed = await api('GET', '/api/v1/devices?role=compute');
    expect(listed.json.items).toEqual([
      expect.objectContaining({
        id: nodeId,
        name: 'gpu-box',
        status: 'active',
        models: ['llama3'],
        load: { running: 0, queued: 0 },
        capabilities: expect.objectContaining({ maxConcurrentJobs: 1 }),
      }),
    ]);
    const ref = `node:${nodeId}/llama3`;
    const models = await api('GET', '/api/v1/models');
    expect(models.json.items).toContainEqual(
      expect.objectContaining({ ref, source: 'node', nodeId }),
    );

    // The node credential does not authenticate as a user.
    const credential = JSON.parse(readFileSync(join(dir, 'node', 'node.json'), 'utf8')).enrollment
      .credential as string;
    const asUser = await api('GET', '/api/v1/threads', undefined, {
      authorization: `Bearer ${credential}`,
    });
    expect(asUser.status).toBe(401);
    expect(
      (await api('GET', '/api/v1/devices', undefined, { authorization: `Bearer ${credential}` }))
        .status,
    ).toBe(401);

    // A chat turn through the Hub runs on the node and records where it ran (FR-127).
    const thread = await api('POST', '/api/v1/threads', { model: ref });
    expect(thread.status).toBe(201);
    const sent = await api('POST', `/api/v1/threads/${thread.json.id}/messages`, {
      text: 'hello node',
    });
    expect(sent.status).toBe(202);
    const reply = await waitFor(async () => {
      const d = await api('GET', `/api/v1/threads/${thread.json.id}`);
      const m = d.json.messages.find(
        (x: { role: string; status: string }) => x.role === 'assistant',
      );
      return m && m.status !== 'streaming' ? m : null;
    });
    expect(reply.status).toBe('complete');
    expect(reply.parts).toContainEqual({ type: 'text', text: 'Echo: hello node' });
    const turn = db.raw.prepare('SELECT execution_location FROM turn').get();
    expect(turn).toEqual({ execution_location: `node:${nodeId}` });

    // Cancelling a streaming job stops the backend request on the node.
    backend.delayMs = 40;
    const [target] = await source.targets((await hub.auth.ownerAccount())!.id, ref);
    const ac = new AbortController();
    const seen: StreamEvent[] = [];
    const req = {
      model: 'llama3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a b c d e f g h' }] }],
      signal: ac.signal,
    } as ChatRequest;
    for await (const e of target!.provider.stream(req, { requestId: 'cancel' })) {
      seen.push(e);
      if (e.type === 'text_delta') ac.abort();
    }
    expect(seen.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
    await waitFor(() => Promise.resolve(backend.aborted === 1 && backend.active === 0));

    // Revocation: the node's next call gets 401 and it stops; its models leave /models.
    expect((await api('POST', `/api/v1/devices/${nodeId}/revoke`)).json).toEqual({ ok: true });
    await node!.beat();
    expect(await node!.done).toBe('revoked');
    node = null;
    const after = await api('GET', '/api/v1/devices');
    expect(after.json.items[0]).toMatchObject({ id: nodeId, status: 'revoked', models: [] });
    expect(
      (await api('GET', '/api/v1/models')).json.items.some(
        (m: { source: string }) => m.source === 'node',
      ),
    ).toBe(false);
    const late = await collect(
      target!.provider.stream(
        { ...req, signal: new AbortController().signal },
        { requestId: 'late' },
      ),
    );
    expect(late.stop).toBe('error');

    const names = (await hub.events.since(null, 500)).map((e) => e.name);
    expect(names).toContain('node.registered');
    expect(names).toContain('node.status.changed');
  });

  it('refuses a second registration with the same enrollment token', async () => {
    const start = await api('POST', '/api/v1/devices/add/start', { role: 'compute' });
    const opts = {
      hubUrl,
      token: start.json.token as string,
      backendUrl: backend.url,
      backendKind: 'llamacpp' as const,
      listen: '127.0.0.1:0',
      advertise: 'http://127.0.0.1:7420',
    };
    await enroll({ ...opts, dataDir: join(dir, 'a') });
    await expect(enroll({ ...opts, dataDir: join(dir, 'b') })).rejects.toThrow(
      /invalid, used or expired/,
    );
  });
});
