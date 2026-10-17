// The screen area (FR-093, FR-207, FR-098, FR-087, FR-075; docs/18 J8 step 6, J7 step 8): every
// route needs a session and the account's own computer; the computer-use tools keep the browser
// view-only and the terminal click-only; the kill key route stops delivery; grants, recorded
// actions with screenshots, takeover with its audit and events, the live view socket, appshots,
// and `screen.request_access` through the request broker.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type ScreenStatusView,
  type SettingKey,
} from '@nova/shared';
import {
  MockDesktops,
  type AskResult,
  type AuditRecord,
  type BrowserAction,
  type Computer,
  type ComputerProvider,
  type ToolContext,
  type ToolResult,
} from '@nova/core';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupScreen, type ScreenArea } from '../src/screen.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
const PC = 'computer-1';
const AUTH = { 'x-account': ACCOUNT };
let dir: string;
let db: NovaDatabase;
let events: EventStore;
let audit: AuditRecord[];
let hooks: { which: string; reason: string }[];
let desktops: MockDesktops;
let browserActions: BrowserAction[];
let browserInputs: unknown[];
let area: ScreenArea;
let app: FastifyInstance;
let url: string;

function computer(id: string): Computer {
  const no = () => Promise.reject(new Error('not in the screen tests'));
  return {
    id,
    kind: 'cloud',
    fs: { read: no, write: no, list: no, stat: no, delete: no, move: no },
    exec: no,
    browser: () =>
      Promise.resolve({
        read: () =>
          Promise.resolve({
            url: 'https://example.test/',
            title: 'Example',
            text: '',
            elements: [],
          }),
        act: (action: BrowserAction) => {
          browserActions.push(action);
          return Promise.resolve({ ok: true, page: null });
        },
        screenshot: () =>
          Promise.resolve(new MockDesktops({ width: 8, height: 6 }).desktop('b').observe().image),
        close: () => Promise.resolve(),
        // The takeover hooks of the browser area's controller.
        pause: () => Promise.resolve(),
        resume: () => undefined,
        input: (event: unknown) => {
          browserInputs.push(event);
          return Promise.resolve();
        },
      }),
    screen: () => Promise.resolve(desktops.screen(id)),
    snapshot: no,
    restore: no,
    status: () => Promise.resolve({ state: 'running', substrate: 'cloud_stub', detail: null }),
    stop: no,
  };
}

const computers: ComputerProvider = {
  get: (accountId, id) => Promise.resolve(accountId === ACCOUNT && id === PC ? computer(id) : null),
  forAgent: () => Promise.reject(new Error('not in the screen tests')),
};

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
    setting: (key: SettingKey) => Promise.resolve(SETTINGS[key].default as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-screen-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'agent', 'idle', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  events = new EventStore(db);
  audit = [];
  hooks = [];
  browserActions = [];
  browserInputs = [];
  desktops = new MockDesktops();
  area = await setupScreen({
    ...context(),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    computers,
    // A fixed clock: grant lifetimes read exactly.
    now: () => new Date('2026-10-17T10:00:00.000Z'),
    liveIntervalMs: 30,
    observeIntervalMs: 0,
  });
  area.useComputerOf((accountId, threadId) =>
    Promise.resolve(
      accountId === ACCOUNT && threadId === THREAD ? { computerId: PC, agentId: 'agent-1' } : null,
    ),
  );
  area.useAgentControl({
    pause: (i) => (hooks.push({ which: 'pause', reason: i.reason }), Promise.resolve()),
    resume: (i) => (hooks.push({ which: 'resume', reason: i.reason }), Promise.resolve()),
  });
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
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await app.close();
  await area.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown,
  headers: Record<string, string> = AUTH,
) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    headers,
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });

function toolCtx(): ToolContext {
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: 'call-1',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: {} as never,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
  };
}

async function tool(name: string, args: unknown = {}): Promise<ToolResult> {
  const list = await area.tools.list(ACCOUNT, { threadId: THREAD, mode: 'agent' });
  return list.find((t) => t.descriptor.name === name)!.handler(args, toolCtx());
}
const code = (r: ToolResult) => (r.ok ? 'ok' : r.error.code);
const desktop = () => desktops.desktop(PC);

describe('screen routes', () => {
  it('need a session and the account’s own computer', async () => {
    expect((await call('GET', `/computers/${PC}/screen`, undefined, {})).statusCode).toBe(401);
    expect((await call('GET', '/computers/other/screen')).statusCode).toBe(404);
    expect((await call('POST', '/computers/other/takeover', {})).statusCode).toBe(404);
    expect(
      (await call('PUT', `/computers/${PC}/screen/control`, { enabled: 'yes' })).statusCode,
    ).toBe(400);
    const r = await call('GET', `/computers/${PC}/screen`);
    expect(r.json()).toMatchObject({
      computerId: PC,
      enabled: false,
      state: 'disabled',
      indicator: { killKey: 'Escape' },
    });
  });

  it('J8 step 6: the browser is view-only, the terminal click-only, and the kill key stops delivery', async () => {
    expect(
      (await call('PUT', `/computers/${PC}/screen/control`, { enabled: true })).json(),
    ).toMatchObject({
      enabled: true,
      state: 'idle',
    });
    for (const app of ['Web Browser', 'Terminal'])
      expect((await call('POST', `/computers/${PC}/screen/grants`, { app })).statusCode).toBe(201);
    const status = (await call('GET', `/computers/${PC}/screen`)).json<ScreenStatusView>();
    expect(status).toMatchObject({
      state: 'controlling',
      indicator: { visible: true, apps: ['Terminal', 'Web Browser'] },
    });
    expect(code(await tool('screen.observe'))).toBe('ok');
    const browser = await tool('screen.click', { x: 100, y: 100 });
    expect(browser).toMatchObject({
      ok: false,
      error: { code: 'screen_tier', details: { tier: 'view', useInstead: 'browser' } },
    });
    expect(code(await tool('screen.click', { x: 260, y: 457 }))).toBe('ok');
    expect(code(await tool('screen.scroll', { x: 260, y: 457, dy: 10 }))).toBe('ok');
    expect(await tool('screen.type', { text: 'ls' })).toMatchObject({
      ok: false,
      error: { code: 'screen_tier', details: { tier: 'click', useInstead: 'shell' } },
    });
    const delivered = desktop().delivered.length;
    expect(delivered).toBe(2);
    // The kill key: control stops, the agent is paused, nothing more is delivered.
    const killed = (await call('POST', `/computers/${PC}/screen/kill`)).json<ScreenStatusView>();
    expect(killed).toMatchObject({
      state: 'stopped',
      stoppedBy: 'user',
      indicator: { visible: false },
    });
    expect(hooks).toEqual([{ which: 'pause', reason: 'kill' }]);
    expect(code(await tool('screen.click', { x: 260, y: 457 }))).toBe('screen_stopped');
    expect(desktop().delivered).toHaveLength(delivered);
    expect(audit.filter((a) => a.kind === 'screen').map((a) => a.action)).toContain('screen.kill');
    expect((await call('POST', `/computers/${PC}/screen/resume`)).json()).toMatchObject({
      state: 'controlling',
    });
    expect(hooks.at(-1)).toEqual({ which: 'resume', reason: 'kill' });
    const persisted = await events.since(null, 200, { accountId: ACCOUNT });
    expect(persisted.map((e) => e.name)).toEqual(
      expect.arrayContaining(['screen.control.changed', 'screen.grant.changed', 'screen.action']),
    );
  });

  it('lists, renews and revokes grants', async () => {
    expect((await call('POST', `/computers/${PC}/screen/grants`, { app: '' })).statusCode).toBe(
      400,
    );
    const g = (
      await call('POST', `/computers/${PC}/screen/grants`, { app: 'Expense Form', minutes: 15 })
    ).json<{
      id: string;
      remainingSeconds: number;
      tier: string;
    }>();
    expect(g).toMatchObject({ remainingSeconds: 900, tier: 'full' });
    expect((await call('GET', `/computers/${PC}/screen/grants`)).json()).toMatchObject({
      items: [{ id: g.id }],
    });
    expect(
      (await call('POST', `/computers/${PC}/screen/grants/${g.id}/renew`)).json(),
    ).toMatchObject({
      remainingSeconds: 1800,
    });
    expect((await call('DELETE', `/computers/${PC}/screen/grants/${g.id}`)).json()).toMatchObject({
      active: false,
    });
    expect((await call('GET', `/computers/${PC}/screen/grants`)).json()).toEqual({ items: [] });
    expect((await call('GET', `/computers/${PC}/screen/grants?all=true`)).json()).toMatchObject({
      items: [{ id: g.id }],
    });
    expect((await call('DELETE', `/computers/${PC}/screen/grants/missing`)).statusCode).toBe(404);
    expect(
      (await call('POST', `/computers/${PC}/screen/grants`, { app: 'Password Manager' }))
        .statusCode,
    ).toBe(403);
  });

  it('serves the screen, recorded actions and their screenshots', async () => {
    const obs = (await call('GET', `/computers/${PC}/screen/observation`)).json<{
      windows: unknown[];
      image: string;
    }>();
    expect(obs.windows).toHaveLength(4);
    const frame = await call('GET', `/computers/${PC}/screen/frame`);
    expect(frame.headers['content-type']).toBe('image/png');
    expect(frame.headers['cache-control']).toBe('no-store');
    expect(frame.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const page = await call('GET', `/computers/${PC}/screen/frame?surface=browser`);
    expect(page.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    await call('PUT', `/computers/${PC}/screen/control`, { enabled: true });
    await call('POST', `/computers/${PC}/screen/grants`, { app: 'Expense Form' });
    await tool('screen.observe');
    const click = await tool('screen.click', { x: 690, y: 74 });
    expect(code(click)).toBe('ok');
    const actions = (await call('GET', `/computers/${PC}/screen/actions?limit=10`)).json<{
      items: { id: string; hasBefore: boolean; kind: string }[];
    }>();
    expect(actions.items).toMatchObject([{ kind: 'click', hasBefore: true }]);
    const id = actions.items[0]!.id;
    const shot = await call('GET', `/computers/${PC}/screen/actions/${id}/after`);
    expect(shot.headers['content-type']).toBe('image/png');
    expect((await call('GET', `/computers/${PC}/screen/actions/${id}/sideways`)).statusCode).toBe(
      400,
    );
    expect((await call('GET', `/computers/${PC}/screen/actions/missing/before`)).statusCode).toBe(
      404,
    );
  });

  it('J7 step 8: takes over, returns control and audits both', async () => {
    const t = await call('POST', `/computers/${PC}/takeover`, {});
    expect(t.statusCode).toBe(201);
    expect(t.json()).toMatchObject({ computerId: PC, surface: 'desktop', startedBy: 'user' });
    expect((await call('POST', `/computers/${PC}/takeover`, {})).statusCode).toBe(409);
    expect((await call('GET', `/computers/${PC}/takeover`)).json()).toMatchObject({
      takeover: { surface: 'desktop' },
    });
    expect((await call('GET', `/computers/${PC}/screen`)).json()).toMatchObject({
      state: 'taken_over',
    });
    expect(
      (
        await call('POST', `/computers/${PC}/takeover/input`, {
          action: { kind: 'click', x: 260, y: 457 },
        })
      ).json(),
    ).toEqual({ ok: true, error: null });
    await call('POST', `/computers/${PC}/takeover/input`, { action: { kind: 'type', text: 'ls' } });
    expect(desktop().widget('w-terminal', 'Output')!.value).toBe('$ ls');
    expect(
      (await call('POST', `/computers/${PC}/takeover/input`, { action: { kind: 'wave' } }))
        .statusCode,
    ).toBe(400);
    const ended = await call('POST', `/computers/${PC}/takeover/end`);
    expect(ended.json()).toMatchObject({ endReason: 'returned', inputCount: 2 });
    expect((await call('POST', `/computers/${PC}/takeover/end`)).statusCode).toBe(409);
    expect(hooks).toEqual([
      { which: 'pause', reason: 'takeover' },
      { which: 'resume', reason: 'takeover' },
    ]);
    expect(audit.filter((a) => a.kind === 'computer')).toMatchObject([
      { action: 'computer.takeover.started', actor: 'user', resource: `computer:${PC}` },
      { action: 'computer.takeover.ended', actor: 'user', result: 'returned' },
    ]);
    const persisted = (await events.since(null, 200, { accountId: ACCOUNT })).filter((e) =>
      e.name.startsWith('computer.takeover'),
    );
    expect(persisted).toMatchObject([
      {
        name: 'computer.takeover.started',
        actor: 'user',
        payload: { computerId: PC, actor: 'user' },
      },
      {
        name: 'computer.takeover.ended',
        actor: 'user',
        payload: { computerId: PC, actor: 'user', inputs: 2 },
      },
    ]);
    // The browser can be taken over too.
    expect(
      (await call('POST', `/computers/${PC}/takeover`, { surface: 'browser' })).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', `/computers/${PC}/takeover/input`, {
          browser: { kind: 'type', text: 'hello' },
        })
      ).json(),
    ).toEqual({ ok: true, error: null });
    expect(browserInputs).toEqual([{ kind: 'type', text: 'hello' }]);
    expect(
      (
        await call('POST', `/computers/${PC}/takeover/input`, {
          browser: { kind: 'navigate', url: 'https://example.test/a' },
        })
      ).statusCode,
    ).toBe(400);
    await call('POST', `/computers/${PC}/takeover/end`);
  });

  it('saves and lists appshots', async () => {
    const r = await call('POST', `/computers/${PC}/appshots`, {
      app: 'Terminal',
      threadId: THREAD,
    });
    expect(r.statusCode).toBe(201);
    const shot = r.json<{ id: string; artifactId: string; width: number }>();
    expect(shot).toMatchObject({
      app: 'Terminal',
      width: 440,
      height: 260,
      threadId: THREAD,
      capturedBy: 'user',
    });
    expect(
      db.raw.prepare('SELECT kind, mime FROM artifact WHERE id = ?').get(shot.artifactId),
    ).toEqual({
      kind: 'image',
      mime: 'image/png',
    });
    expect(
      (await call('POST', `/computers/${PC}/appshots`, { source: 'browser' })).json(),
    ).toMatchObject({
      url: 'https://example.test/',
    });
    expect(
      (await call('GET', `/appshots?computerId=${PC}`)).json<{ items: unknown[] }>().items,
    ).toHaveLength(2);
    expect((await call('GET', `/appshots/${shot.id}`)).json()).toMatchObject({ id: shot.id });
    expect((await call('GET', '/appshots/missing')).statusCode).toBe(404);
    expect(
      (await call('POST', `/computers/${PC}/appshots`, { source: 'elsewhere' })).statusCode,
    ).toBe(400);
  });

  it('asks the user for access through the request broker', async () => {
    const answers: AskResult[] = [
      { status: 'resolved', result: { choice: 'Allow for 30 min' }, by: 'user' },
    ];
    area.useRequests({ ask: () => Promise.resolve(answers.shift() ?? { status: 'expired' }) });
    const r = await tool('screen.request_access', { apps: ['Expense Form'] });
    expect(r).toMatchObject({ ok: true });
    expect((await call('GET', `/computers/${PC}/screen/grants`)).json()).toMatchObject({
      items: [{ app: 'Expense Form', tier: 'full' }],
    });
    expect(await area.tools.list(ACCOUNT, { threadId: THREAD, mode: 'chat' })).toEqual([]);
  });
});

describe('the live view socket', () => {
  function open(path: string, headers: Record<string, string> = AUTH) {
    return new Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }>((resolve, reject) => {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`${url.replace('http', 'ws')}/api/v1${path}`, { headers });
      ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as never));
      ws.on('open', () => resolve({ ws, frames }));
      ws.on('error', reject);
    });
  }
  async function until(
    frames: Record<string, unknown>[],
    pred: (f: Record<string, unknown>) => boolean,
  ) {
    for (let i = 0; i < 200; i++) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no matching frame in ${JSON.stringify(frames.map((f) => f.type))}`);
  }

  it('streams frames and state, takes input during a takeover and the kill key', async () => {
    await expect(open(`/computers/${PC}/screen/live`, {})).rejects.toThrow('401');
    await expect(open('/computers/other/screen/live')).rejects.toThrow('404');
    const { ws, frames } = await open(`/computers/${PC}/screen/live`);
    expect(await until(frames, (f) => f.type === 'state')).toMatchObject({
      status: { state: 'disabled' },
    });
    const frame = await until(frames, (f) => f.type === 'frame');
    expect(frame).toMatchObject({ surface: 'desktop', mime: 'image/png', width: 960, height: 600 });
    await call('POST', `/computers/${PC}/takeover`, {});
    await until(
      frames,
      (f) => f.type === 'state' && (f.status as ScreenStatusView).state === 'taken_over',
    );
    ws.send(JSON.stringify({ type: 'input', action: { kind: 'click', x: 690, y: 74 } }));
    expect(await until(frames, (f) => f.type === 'input.ack')).toEqual({
      type: 'input.ack',
      ok: true,
      error: null,
    });
    ws.send(JSON.stringify({ type: 'wave' }));
    expect(await until(frames, (f) => f.type === 'error')).toMatchObject({
      error: { code: 'validation' },
    });
    ws.send(JSON.stringify({ type: 'refresh' }));
    await call('POST', `/computers/${PC}/takeover/end`);
    await call('PUT', `/computers/${PC}/screen/control`, { enabled: true });
    ws.send(JSON.stringify({ type: 'kill' }));
    await until(
      frames,
      (f) => f.type === 'state' && (f.status as ScreenStatusView).state === 'stopped',
    );
    expect(audit.map((a) => a.action)).toContain('screen.kill');
    ws.close();
  });

  it('streams the browser page', async () => {
    const { ws, frames } = await open(`/computers/${PC}/screen/live?surface=browser`);
    expect(await until(frames, (f) => f.type === 'frame')).toMatchObject({
      surface: 'browser',
      mime: 'image/png',
    });
    ws.close();
  });
});
