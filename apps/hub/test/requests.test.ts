// The requests area (FR-188, FR-215; contracts/hub-api.md §5): sessions on every route, the
// first valid answer wins (409 after, 410 once expired), pending approvals listed and answered
// as `approval` requests, WebSocket `request` / `respond` / `respond.ack` frames for the kinds a
// client declared in its handshake, `user.ask` through HTTP, and the derived thread status.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type ServerRequestView,
  type SettingKey,
  type ToolDescriptor,
} from '@nova/shared';
import type { AskInput, AuditRecord, NotificationInput, ToolContext } from '@nova/core';
import { loadMigrations, migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';
import { CLIENT_SESSION_HEADER, setupRequests, type RequestsArea } from '../src/requests.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
const CHAT = '01920000-0000-7000-8000-0000000000a2';
const AUTH = { 'x-account': ACCOUNT };

/** Every migration, or every one before 0019_requests (a Hub that has no requests table). */
async function openRequestsDb(withRequests = true): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  const migrations = loadMigrations().filter((m) => withRequests || m.name !== 'requests');
  await migrate(db, { migrations });
  return db;
}

const execTool: ToolDescriptor = {
  name: 'exec.run',
  title: 'Run command',
  description: 'Run a command in the sandbox',
  source: 'builtin',
  inputSchema: { type: 'object' },
  annotations: { destructive: true },
  effects: ['exec'],
};

let dir: string;
let db: NovaDatabase;
let events: EventStore;
let notes: NotificationInput[];
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let timers: { fn: () => void; ms: number; live: boolean }[];
let area: RequestsArea;
let policy: PolicyAreaFull;
let app: FastifyInstance;
let url: string;

function context(): HubContext {
  return {
    config: {},
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: {},
    dataDir: join(dir, 'data'),
    registry: {},
    router: {},
    nodes: {},
    threads: {},
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
}

const setTimer = (fn: () => void, ms: number) => {
  const t = { fn, ms, live: true };
  timers.push(t);
  return () => {
    t.live = false;
  };
};
const fire = (ms: number) => {
  for (const t of timers.filter((x) => x.live && x.ms === ms)) {
    t.live = false;
    t.fn();
  }
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-requests-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = await openRequestsDb();
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  for (const [id, mode] of [
    [THREAD, 'work'],
    [CHAT, 'chat'],
  ] as const)
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, 'streaming', ?, ?)",
      )
      .run(id, ACCOUNT, mode, now, now);
  events = new EventStore(db);
  notes = [];
  audit = [];
  settings = {};
  timers = [];
  const ctx = context();
  policy = await setupPolicy(
    {
      ...ctx,
      audit: { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) },
      notifier: { notify: (n: NotificationInput) => (notes.push(n), Promise.resolve()) },
    },
    { home: join(dir, 'home'), approvalTimeoutMs: () => 60_000 },
  );
  area = await setupRequests(ctx, {
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    setTimer,
  });
  area.useApprovals(policy.approvals);
  app = Fastify();
  await app.register(fastifyWebsocket);
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  policy.register(app);
  // The wiring the lead adds to app.ts: the handshake and the stream socket.
  app.post('/api/v1/hello', async (req) => {
    const accountId = await ctx.accountOf(req);
    const body = z
      .object({ capabilities: z.object({ serverRequests: z.unknown() }).partial().optional() })
      .parse(req.body);
    return area.hello({
      accountId,
      deviceId: 'device-web',
      serverRequests: body.capabilities?.serverRequests,
    });
  });
  void app.register((scoped, _o, done) => {
    scoped.get('/api/v1/ws', { websocket: true }, (socket, req) => {
      const q = req.query as { clientSessionId?: string; account?: string };
      if (q.account !== ACCOUNT) {
        socket.close(4401, 'token_required');
        return;
      }
      const conn = area.attachClient({
        accountId: ACCOUNT,
        deviceId: 'device-web',
        clientSessionId: q.clientSessionId ?? null,
        send: (frame) => socket.send(JSON.stringify(frame)),
      });
      socket.on('message', (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        void conn.handle(msg).then((handled) => {
          if (!handled && (msg as { type?: string }).type === 'ping')
            socket.send(JSON.stringify({ type: 'pong' }));
        });
      });
      socket.on('close', () => conn.detach());
    });
    done();
  });
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await app.close();
  await area.close();
  await policy.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', path: string, payload?: unknown, headers = AUTH) =>
  app.inject({
    method,
    url: path,
    headers,
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });

const question = (over: Partial<AskInput> = {}): AskInput => ({
  accountId: ACCOUNT,
  kind: 'user_input',
  correlation: { threadId: THREAD, turnId: 'turn-1' },
  payload: { question: 'Deploy to staging?', choices: ['yes', 'no'] },
  timeoutMs: 3_600_000,
  ...over,
});

async function asking(input = question()) {
  const result = area.service.ask(input, new AbortController().signal);
  let id = '';
  await vi.waitFor(async () => {
    const created = await events.since(null, 500);
    const last = created.filter((e) => e.name === 'request.created').at(-1);
    expect(last).toBeDefined();
    id = last!.payload.requestId as string;
    expect((await area.service.list(ACCOUNT)).some((r) => r.id === id)).toBe(true);
  });
  return { result, id };
}

describe('routes', () => {
  it('require a session', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/requests'],
      ['GET', '/api/v1/requests/x'],
      ['POST', '/api/v1/requests/x/respond'],
    ] as const) {
      const res = await call(
        method,
        path,
        method === 'POST' ? { result: {} } : undefined,
        {} as never,
      );
      expect(res.statusCode, `${method} ${path}`).toBe(401);
    }
  });

  it('list, answer once, and refuse a second answer with the winning resolution', async () => {
    expect((await call('GET', '/api/v1/requests')).json()).toEqual({ items: [] });
    const { result, id } = await asking();
    const list = (await call('GET', `/api/v1/requests?threadId=${THREAD}`)).json<{
      items: ServerRequestView[];
    }>();
    expect(list.items).toEqual([
      expect.objectContaining({ id, kind: 'user_input', status: 'pending', resolution: null }),
    ]);
    expect((await call('GET', `/api/v1/requests/${id}`)).json()).toMatchObject({ id });
    expect((await call('POST', `/api/v1/requests/${id}/respond`, {})).statusCode).toBe(400);
    expect(
      (await call('POST', `/api/v1/requests/${id}/respond`, { result: {}, extra: 1 })).statusCode,
    ).toBe(400);
    const bad = await call('POST', `/api/v1/requests/${id}/respond`, {
      result: { choice: 'maybe' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call('POST', `/api/v1/requests/${id}/respond`, { result: { choice: 'yes' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      status: 'resolved',
      resolution: { by: 'user', result: { choice: 'yes' } },
    });
    expect(await result).toEqual({ status: 'resolved', result: { choice: 'yes' }, by: 'user' });
    const late = await call('POST', `/api/v1/requests/${id}/respond`, { result: { choice: 'no' } });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({
      error: { code: 'conflict', details: { resolution: { result: { choice: 'yes' } } } },
    });
    expect(
      (await call('GET', '/api/v1/requests?status=all')).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
    expect((await call('GET', '/api/v1/requests')).json()).toEqual({ items: [] });
    expect((await call('POST', '/api/v1/requests/nope/respond', { result: {} })).statusCode).toBe(
      404,
    );
    expect((await call('GET', '/api/v1/requests?status=some')).statusCode).toBe(400);
  });

  it('answers 410 once a request expired', async () => {
    const { result, id } = await asking(question({ timeoutMs: 5_000 }));
    fire(5_000);
    expect(await result).toEqual({ status: 'expired' });
    const res = await call('POST', `/api/v1/requests/${id}/respond`, { result: { choice: 'yes' } });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: { code: 'request_expired' } });
    // Nobody could have answered it: the user was notified.
    expect(notes.some((n) => n.dedupeKey === `request:${id}`)).toBe(true);
  });

  it('lists pending approvals as approval requests and answers them through the approvals flow', async () => {
    const outcome = policy.gate.check(
      {
        accountId: ACCOUNT,
        threadId: CHAT,
        turnId: '',
        callId: 'call-1',
        projectId: null,
        mode: 'chat',
        tool: execTool,
        args: { cmd: 'npm publish' },
        argsPreview: '{"cmd":"npm publish"}',
        provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
        profile: { id: 'workspace', hash: 'h' },
      },
      new AbortController().signal,
    );
    let item: ServerRequestView | undefined;
    await vi.waitFor(async () => {
      item = (await call('GET', '/api/v1/requests')).json<{ items: ServerRequestView[] }>()
        .items[0];
      expect(item?.kind).toBe('approval');
    });
    expect(item).toMatchObject({
      correlation: { threadId: CHAT, callId: 'call-1' },
      payload: { action: 'Run `npm publish`', tier: 'pre_approvable', nativeClientOnly: false },
    });
    const res = await call('POST', `/api/v1/requests/${item!.id}/respond`, {
      result: { decision: 'allow_once' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'approval',
      status: 'resolved',
      resolution: { result: { decision: 'allow_once' } },
    });
    expect(await outcome).toMatchObject({ effect: 'allow' });
    const again = await call('POST', `/api/v1/requests/${item!.id}/respond`, {
      result: { decision: 'deny_continue' },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('WebSocket frames (contracts/hub-api.md §5)', () => {
  async function hello(serverRequests: unknown) {
    const res = await call('POST', '/api/v1/hello', { capabilities: { serverRequests } });
    return res.json<{ serverRequests: string[]; clientSessionId: string }>();
  }

  function open(query: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
    return new Promise((resolve, reject) => {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(
        `${url.replace('http', 'ws')}/api/v1/ws?account=${ACCOUNT}&${query}`,
      );
      ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as never));
      ws.on('open', () => resolve({ ws, frames }));
      ws.on('error', reject);
    });
  }

  it('sends requests to clients that declared the kind and resolves them from respond frames', async () => {
    const declared = await hello(['user_input', 'approval', 'bogus']);
    expect(declared.serverRequests).toEqual(['approval', 'user_input']);
    const { ws, frames } = await open(`clientSessionId=${declared.clientSessionId}`);
    const plain = await open('');
    const other = await hello(['credential_refresh']);
    const elsewhere = await open(`clientSessionId=${other.clientSessionId}`);
    const { result, id } = await asking();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ type: 'request', request: { id, kind: 'user_input' } });
    ws.send(JSON.stringify({ type: 'respond', requestId: id, result: { choice: 'no' } }));
    await vi.waitFor(() =>
      expect(frames.at(-1)).toEqual({ type: 'respond.ack', requestId: id, status: 'resolved' }),
    );
    expect(await result).toMatchObject({ status: 'resolved', result: { choice: 'no' } });
    const resolved = (await events.since(null, 500)).find((e) => e.name === 'request.resolved')!;
    expect(resolved.payload).toMatchObject({ requestId: id, deviceId: 'device-web' });
    ws.send(JSON.stringify({ type: 'respond', requestId: id, result: { choice: 'yes' } }));
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ status: 'conflict' }));
    ws.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() => expect(frames.at(-1)).toEqual({ type: 'pong' }));
    expect(plain.frames).toEqual([]);
    expect(elsewhere.frames).toEqual([]);
    for (const s of [ws, plain.ws, elsewhere.ws]) s.close();
  });

  it('re-sends pending requests when a client reconnects', async () => {
    const declared = await hello(['user_input']);
    const { result, id } = await asking();
    const { ws, frames } = await open(`clientSessionId=${declared.clientSessionId}`);
    await vi.waitFor(() =>
      expect(frames).toEqual([{ type: 'request', request: expect.objectContaining({ id }) }]),
    );
    // A handshake session of another account is ignored.
    expect(area.clientSession('someone-else', declared.clientSessionId)).toBeNull();
    expect(area.clientSession(ACCOUNT, declared.clientSessionId)).toMatchObject({
      deviceId: 'device-web',
    });
    const res = await call(
      'POST',
      `/api/v1/requests/${id}/respond`,
      { result: { text: 'later' } },
      {
        ...AUTH,
        [CLIENT_SESSION_HEADER]: declared.clientSessionId,
      } as never,
    );
    expect(res.statusCode).toBe(200);
    expect(await result).toMatchObject({ result: { text: 'later' } });
    ws.close();
  });

  it('pushes new approvals to clients that declared approvals', async () => {
    const declared = await hello(['approval']);
    const { ws, frames } = await open(`clientSessionId=${declared.clientSessionId}`);
    const outcome = policy.gate.check(
      {
        accountId: ACCOUNT,
        threadId: CHAT,
        turnId: '',
        callId: 'call-2',
        projectId: null,
        mode: 'chat',
        tool: execTool,
        args: { cmd: 'make deploy' },
        argsPreview: '{}',
        provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
        profile: { id: 'workspace', hash: 'h' },
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const request = (frames[0] as { request: ServerRequestView }).request;
    expect(request).toMatchObject({ kind: 'approval', correlation: { callId: 'call-2' } });
    ws.send(
      JSON.stringify({
        type: 'respond',
        requestId: request.id,
        result: { approvalId: request.id, decision: 'deny_continue', reason: 'not now' },
      }),
    );
    expect(await outcome).toMatchObject({ effect: 'deny', reason: 'not now' });
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({ type: 'respond.ack', status: 'resolved' }),
    );
    ws.close();
  });
});

describe('user.ask and the thread status', () => {
  function toolCtx(over: Partial<ToolContext> = {}): ToolContext {
    return {
      accountId: ACCOUNT,
      threadId: THREAD,
      turnId: '',
      callId: 'call-ask',
      projectId: null,
      origin: 'model',
      profile: { id: 'workspace', hash: 'h' },
      roots: [],
      sandbox: {} as never,
      signal: new AbortController().signal,
      log: new Logger({ module: 'test', sinks: [] }),
      ...over,
    };
  }

  it('asks in a Work thread, shows Needs input, and returns the answer typed in a client', async () => {
    const [ask] = await area.tools.list(ACCOUNT);
    expect(ask!.descriptor.name).toBe('user.ask');
    settings['policy.approvalTimeoutMinutes'] = 30;
    const pending = ask!.handler({ question: 'Which region?' }, toolCtx());
    let id = '';
    await vi.waitFor(async () => {
      const items = (await call('GET', '/api/v1/requests')).json<{ items: ServerRequestView[] }>()
        .items;
      expect(items).toHaveLength(1);
      id = items[0]!.id;
      expect(Date.parse(items[0]!.expiresAt) - Date.parse(items[0]!.createdAt)).toBe(30 * 60_000);
    });
    expect((await area.status.statusOf(ACCOUNT, [THREAD])).get(THREAD)).toEqual({
      status: 'needs_input',
      reason: 'Question for you',
    });
    await vi.waitFor(async () => {
      const changed = (await events.since(null, 500)).filter(
        (e) => e.name === 'thread.status.changed',
      );
      expect(changed.at(-1)?.payload).toMatchObject({ status: 'needs_input', ref: { id: THREAD } });
    });
    await call('POST', `/api/v1/requests/${id}/respond`, { result: { text: 'eu-west' } });
    expect(await pending).toMatchObject({
      ok: true,
      content: [{ type: 'text', text: 'The user answered: eu-west' }],
    });
    await area.status.idle();
    expect((await area.status.statusOf(ACCOUNT, [THREAD])).get(THREAD)!.status).toBe('ready');
    expect(await ask!.handler({ question: 'q' }, toolCtx({ threadId: CHAT }))).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
  });

  it('takes status sources from the modes', async () => {
    area.useStatusSources({
      blocked: (_a, ids) => Promise.resolve(new Map(ids.map((id) => [id, 'Budget reached']))),
      children: () => Promise.resolve([]),
    });
    expect((await area.status.statusOf(ACCOUNT, [THREAD])).get(THREAD)).toEqual({
      status: 'blocked',
      reason: 'Budget reached',
    });
  });
});

describe('setup', () => {
  it('starts without the requests table and recovers pending rows after a restart', async () => {
    const bare = await openRequestsDb(false);
    const saved = db;
    db = bare;
    const ctx = context();
    const a = await setupRequests(ctx);
    a.useNotifier({ notify: () => Promise.resolve() });
    expect(await ctx.diagnostics.collect()).toMatchObject({ requests: { waiting: 0, clients: 0 } });
    await a.close();
    db = saved;
    bare.close();

    db.raw
      .prepare(
        `INSERT INTO server_request (id, account_id, kind, thread_id, payload_json, status, created_at, expires_at)
         VALUES ('stale', ?, 'user_input', ?, '{"question":"q"}', 'pending', ?, ?)`,
      )
      .run(ACCOUNT, THREAD, '2026-10-17T09:00:00.000Z', '2026-10-18T09:00:00.000Z');
    const again = await setupRequests(context());
    expect(await again.service.get(ACCOUNT, 'stale')).toMatchObject({ status: 'expired' });
    await again.close();
  });
});
