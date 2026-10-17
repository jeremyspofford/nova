// NodeModelSource and NodeProvider against a real in-process compute node (services/compute on an
// ephemeral port, with a scripted OpenAI-compatible backend). The node enrolls through an
// in-process Hub transport that calls NodeService directly (FR-126, FR-127).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { httpStatusFor, isNovaError } from '@nova/shared';
import { collect, type ChatRequest, type StreamEvent } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { ComputeNode, enroll, startFakeBackend, type FakeBackend } from '@nova/compute';
import {
  MemoryEventSink,
  NodeModelSource,
  NodeProvider,
  NodeService,
  jobTokenRef,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const HUB = 'http://hub.test';

let db: NovaDatabase;
let secrets: MemorySecretStore;
let nodes: NodeService;
let source: NodeModelSource;
let backend: FakeBackend;
let node: ComputeNode | null;
let dir: string;
let nodeId: string;

/** Node → Hub calls go straight to NodeService; everything else is real HTTP. */
function hubTransport(svc: NodeService): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== HUB) return fetch(input, init);
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const credential = (new Headers(init?.headers).get('authorization') ?? '').slice(7);
    try {
      let out: unknown = { ok: true };
      if (url.pathname === '/node/v1/register') out = await svc.register(body);
      else if (url.pathname === '/node/v1/heartbeat') await svc.heartbeat(credential, body);
      else if (url.pathname === '/node/v1/models/sync') await svc.syncModels(credential, body);
      else return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 });
      return Response.json(out);
    } catch (err) {
      if (isNovaError(err))
        return Response.json({ error: err.toJSON() }, { status: httpStatusFor(err.code) });
      if (err instanceof ZodError)
        return Response.json(
          { error: { code: 'validation', message: err.message } },
          { status: 400 },
        );
      throw err;
    }
  };
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function startNode(opts: { maxQueue?: number } = {}): Promise<void> {
  const { token } = await nodes.createEnrollToken(ACCOUNT);
  const transport = hubTransport(nodes);
  const state = await enroll({
    hubUrl: HUB,
    token,
    backendUrl: backend.url,
    backendKind: 'llamacpp',
    name: 'gpu-box',
    listen: `127.0.0.1:${await freePort()}`,
    dataDir: dir,
    fetch: transport,
    ...(opts.maxQueue !== undefined ? { maxQueue: opts.maxQueue } : {}),
  });
  nodeId = state.enrollment!.nodeId;
  node = await ComputeNode.start({
    dataDir: dir,
    fetch: transport,
    log: new Logger({ module: 'node', sinks: [new MemorySink()] }),
  });
}

const chat = (model: string, text = 'hello there', signal = new AbortController().signal) =>
  ({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    signal,
  }) as ChatRequest;

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  secrets = new MemorySecretStore();
  nodes = new NodeService({ db, secrets, events: new MemoryEventSink() });
  source = new NodeModelSource({
    nodes,
    provider: { connectTimeoutMs: 2_000, idleTimeoutMs: 5_000 },
  });
  backend = await startFakeBackend({ models: ['llama3', 'qwen3:8b'] });
  dir = mkdtempSync(join(tmpdir(), 'nova-node-routing-'));
  node = null;
});

afterEach(async () => {
  await node?.stop();
  await backend.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NodeModelSource', () => {
  it('lists the models of active nodes and resolves node refs to node targets', async () => {
    await startNode();
    const models = await source.listModels(ACCOUNT);
    expect(models.map((m) => m.ref)).toEqual([`node:${nodeId}/llama3`, `node:${nodeId}/qwen3:8b`]);
    expect(models[0]).toMatchObject({
      kind: 'model',
      provider: 'node',
      source: 'node',
      nodeId,
      modelId: 'llama3',
      label: 'llama3 (gpu-box)',
    });
    const [target] = await source.targets(ACCOUNT, `node:${nodeId}/llama3`);
    expect(target).toMatchObject({
      ref: `node:${nodeId}/llama3`,
      providerKind: 'node',
      providerAccountId: null,
      modelId: 'llama3',
      location: { kind: 'node', nodeId },
      local: true,
    });
    expect(await target!.provider.listModels()).toHaveLength(2);
    expect(await source.targets(ACCOUNT, `node:${nodeId}/missing`)).toEqual([]);
    expect(await source.targets(ACCOUNT, 'acct/llama3')).toEqual([]);
    expect(await source.targets(ACCOUNT, 'node:other/llama3')).toEqual([]);
    expect((await source.targetsForModel(ACCOUNT, 'qwen3:8b')).map((t) => t.ref)).toEqual([
      `node:${nodeId}/qwen3:8b`,
    ]);
    expect(await source.targetsForModel(ACCOUNT, 'nope')).toEqual([]);
    // The first heartbeat already reported the node's load.
    expect(source.load(nodeId)).toEqual({ running: 0, queued: 0 });
  });

  it('follows the backend when its models change', async () => {
    await startNode();
    backend.models.push('mistral');
    await node!.beat();
    expect((await source.listModels(ACCOUNT)).map((m) => m.modelId)).toContain('mistral');
    backend.models.splice(0, backend.models.length, 'llama3');
    await node!.beat();
    expect((await source.listModels(ACCOUNT)).map((m) => m.modelId)).toEqual(['llama3']);
  });
});

describe('NodeProvider through a compute node', () => {
  it('streams a chat job from the node backend', async () => {
    await startNode();
    const [target] = await source.targets(ACCOUNT, `node:${nodeId}/llama3`);
    const out = await collect(target!.provider.stream(chat('llama3'), { requestId: 'r1' }));
    expect(out.text).toBe('Echo: hello there');
    expect(out.stop).toBe('end');
    expect(out.usage.inputTokens).toBe(7);
    const sent = backend.requests.find((r) => r.path === '/v1/chat/completions');
    expect(sent?.body?.model).toBe('llama3');
    expect(node!.jobs.load()).toEqual({ running: 0, queued: 0 });
  });

  it('cancels the job on the node and its backend request when the turn is cancelled', async () => {
    backend.delayMs = 40;
    await startNode();
    const [target] = await source.targets(ACCOUNT, `node:${nodeId}/llama3`);
    const ac = new AbortController();
    const seen: StreamEvent[] = [];
    for await (const e of target!.provider.stream(
      chat('llama3', 'one two three four five six seven eight', ac.signal),
      { requestId: 'r2' },
    )) {
      seen.push(e);
      if (e.type === 'text_delta') ac.abort();
    }
    expect(seen.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
    await waitFor(() => backend.aborted === 1 && backend.active === 0);
    await waitFor(() => node!.jobs.load().running === 0);
  });

  it('answers busy when the node is full', async () => {
    backend.delayMs = 40;
    await startNode({ maxQueue: 0 });
    const [target] = await source.targets(ACCOUNT, `node:${nodeId}/llama3`);
    const ac = new AbortController();
    const stream = target!.provider.stream(chat('llama3', 'a b c d e f g h', ac.signal), {
      requestId: 'r3',
    });
    const first = stream[Symbol.asyncIterator]();
    expect((await first.next()).value).toMatchObject({ type: 'start' });
    const second = await collect(target!.provider.stream(chat('llama3'), { requestId: 'r4' }));
    expect(second.error).toMatchObject({ code: 'rate_limited', retryable: true });
    ac.abort();
    for (let r = await first.next(); !r.done; r = await first.next());
    await waitFor(() => node!.jobs.load().running === 0);
  });

  it('stops in-flight jobs when the node is revoked and drops its models', async () => {
    backend.delayMs = 40;
    await startNode();
    const [target] = await source.targets(ACCOUNT, `node:${nodeId}/llama3`);
    const seen: StreamEvent[] = [];
    for await (const e of target!.provider.stream(chat('llama3', 'a b c d e f g h'), {
      requestId: 'r5',
    })) {
      seen.push(e);
      if (e.type === 'text_delta' && seen.filter((x) => x.type === 'text_delta').length === 1)
        await nodes.revoke(ACCOUNT, nodeId);
    }
    expect(seen.at(-1)).toMatchObject({
      type: 'stop',
      reason: 'error',
      error: { code: 'network', retryable: false },
    });
    expect(await source.listModels(ACCOUNT)).toEqual([]);
    expect(await source.targets(ACCOUNT, `node:${nodeId}/llama3`)).toEqual([]);
    await waitFor(() => backend.active === 0);
    // The node learns of it on its next beat and stops.
    await node!.beat();
    expect(await node!.done).toBe('revoked');
    node = null;
  });

  it('reports a node that refuses the job token or cannot be reached', async () => {
    await startNode();
    const [target] = await source.targets(ACCOUNT, `node:${nodeId}/llama3`);
    await secrets.put(jobTokenRef(nodeId), `nvj_${'w'.repeat(43)}`);
    const refused = await collect(target!.provider.stream(chat('llama3'), { requestId: 'r6' }));
    expect(refused.error).toMatchObject({ code: 'auth_expired', retryable: false });
    await secrets.delete(jobTokenRef(nodeId));
    const missing = await collect(target!.provider.stream(chat('llama3'), { requestId: 'r7' }));
    expect(missing.error).toMatchObject({ code: 'auth_missing' });
    await secrets.put(jobTokenRef(nodeId), `nvj_${'w'.repeat(43)}`);
    await node!.stop();
    node = null;
    const down = await collect(target!.provider.stream(chat('llama3'), { requestId: 'r8' }));
    expect(down.error).toMatchObject({ code: 'network', retryable: true });
  });
});

describe('NodeProvider against a misbehaving node', () => {
  let server: Server;
  let base: string;
  let handler: (path: string, res: ServerResponse) => void;

  beforeEach(async () => {
    server = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => handler(req.url ?? '', res));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const provider = (opts: { idleTimeoutMs?: number } = {}) =>
    new NodeProvider({
      nodeId: 'n',
      name: 'odd',
      endpoint: `${base}/`,
      models: () => Promise.resolve(['m']),
      jobToken: () => Promise.resolve('nvj_token'),
      connectTimeoutMs: 1_000,
      ...opts,
    });

  const jobThen = (stream: (res: ServerResponse) => void) => {
    handler = (path, res) => {
      if (path === '/node/v1/jobs') {
        res.writeHead(201, { 'content-type': 'application/json' }).end('{"jobId":"j1"}');
      } else if (path.endsWith('/stream')) stream(res);
      else res.writeHead(200).end('{}');
    };
  };

  it('maps refusals and broken responses to stop errors', async () => {
    handler = (_p, res) =>
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":{"message":"boom"}}');
    expect((await collect(provider().stream(chat('m'), { requestId: 'x' }))).error).toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
    handler = (_p, res) => res.writeHead(400).end('nope');
    expect((await collect(provider().stream(chat('m'), { requestId: 'x' }))).error).toMatchObject({
      code: 'invalid_request',
    });
    handler = (_p, res) => res.writeHead(201).end('not json');
    expect((await collect(provider().stream(chat('m'), { requestId: 'x' }))).error).toMatchObject({
      code: 'provider_error',
    });
    jobThen((res) => res.writeHead(404).end());
    expect((await collect(provider().stream(chat('m'), { requestId: 'x' }))).error).toMatchObject({
      code: 'invalid_request',
    });
  });

  it('refuses malformed events, early closes and silence', async () => {
    jobThen((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"text_delta","text":"a"}\n\ndata: {"type":"bogus"}\n\n');
    });
    const bad = await collect(provider().stream(chat('m'), { requestId: 'x' }));
    expect(bad.text).toBe('a');
    expect(bad.error).toMatchObject({ code: 'provider_error' });

    jobThen((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"text_delta","text":"a"}\n\n');
    });
    expect((await collect(provider().stream(chat('m'), { requestId: 'x' }))).error).toMatchObject({
      code: 'network',
      retryable: true,
    });

    jobThen((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
    });
    const quiet = await collect(
      provider({ idleTimeoutMs: 50 }).stream(chat('m'), { requestId: 'x' }),
    );
    expect(quiet.error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('stops at once when already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await collect(provider().stream(chat('m', 'x', ac.signal), { requestId: 'x' }));
    expect(out.stop).toBe('cancelled');
  });
});
