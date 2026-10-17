/* eslint-disable @typescript-eslint/require-await */
// The browser area (FR-086, FR-092, FR-094, FR-096, FR-098; docs/11 §4): every route needs a
// session and validates its body; site levels, developer-protocol mode (with its policy switch),
// domain lists, sessions, recorded actions and their screenshots, private sign-in through the
// routes (credentials never echoed or audited), saved logins, the diagnostics probe, the tool
// source per thread mode, and the retention sweep.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NovaError, SETTINGS, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import type {
  AuditRecord,
  BrowserCall,
  BrowserDriver,
  BrowserTakeoverInput,
  DriverLaunchOptions,
  DriverSession,
  PageElement,
  PageSnapshot,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { setupBrowser, type BrowserArea } from '../src/browser.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const WORK = '01920000-0000-7000-8000-0000000000c1';
const CHAT = '01920000-0000-7000-8000-0000000000c2';
const AUTH = { 'x-account': ACCOUNT };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A small scripted browser: two pages, a sign-in form. */
class Driver implements BrowserDriver {
  readonly name = 'fake';
  readonly fills: string[] = [];
  async probe() {
    return { ok: true, detail: 'fake browser' };
  }
  async launch(opts: DriverLaunchOptions): Promise<DriverSession> {
    let url = 'about:blank';
    const fills = this.fills;
    const pages: Record<string, PageElement[]> = {
      'https://login.example/': [
        { ref: 'e1', role: 'textbox', tag: 'input', name: 'Email', autocomplete: 'username' },
        { ref: 'e2', role: 'textbox', tag: 'input', name: 'Password', inputType: 'password' },
      ],
    };
    const snap = async (): Promise<PageSnapshot> => ({
      url,
      title: url,
      text: 'page',
      tree: '',
      elements: pages[url] ?? [],
      frames: [],
    });
    return {
      url: () => url,
      goto: async (u) => {
        if (!opts.allowNavigation(u)) throw new Error('blocked');
        url = u;
        opts.onNavigated?.(u);
        return { status: 200 };
      },
      back: async () => undefined,
      snapshot: snap,
      describe: async (ref) => (await snap()).elements.find((e) => e.ref === ref) ?? null,
      click: async () => undefined,
      fill: async (_ref, text) => {
        fills.push(text);
      },
      select: async () => undefined,
      press: async () => undefined,
      scroll: async () => undefined,
      waitFor: async () => true,
      screenshot: async () => new Uint8Array(PNG),
      download: async () => ({ suggestedName: 'a.txt', data: new Uint8Array([1]) }),
      upload: async () => undefined,
      evaluate: async () => 1,
      callPageTool: async () => null,
      input: async (_e: BrowserTakeoverInput) => undefined,
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => undefined,
    };
  }
}

let dir: string;
let db: NovaDatabase;
let events: EventStore;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let secrets: MemorySecretStore;
let diagnostics: DiagnosticsRegistry;
let policy: PolicyAreaFull;
let area: BrowserArea;
let driver: Driver;
let sweeps: (() => void)[];
let app: FastifyInstance;

function context(): HubContext {
  return {
    config: {},
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets,
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
    diagnostics,
  } as unknown as HubContext;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-browser-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  for (const [id, mode] of [
    [WORK, 'work'],
    [CHAT, 'chat'],
  ] as const)
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, 'streaming', ?, ?)",
      )
      .run(id, ACCOUNT, mode, now, now);
  events = new EventStore(db);
  audit = [];
  settings = {};
  secrets = new MemorySecretStore();
  diagnostics = new DiagnosticsRegistry();
  sweeps = [];
  driver = new Driver();
  const ctx = context();
  const sink = { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) };
  policy = await setupPolicy(
    { ...ctx, audit: sink, notifier: { notify: () => Promise.resolve() } },
    { home: join(dir, 'home'), approvalTimeoutMs: () => 60_000 },
  );
  area = await setupBrowser(ctx, {
    gate: policy.gate,
    audit: sink,
    notifier: { notify: () => Promise.resolve() },
    driver,
    requireEgress: false,
    setTimer: (fn) => {
      sweeps.push(fn);
      return () => undefined;
    },
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await policy.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: AUTH,
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });

let n = 0;
const browserCall = (over: Partial<BrowserCall> = {}): BrowserCall => ({
  accountId: ACCOUNT,
  threadId: WORK,
  turnId: 'turn-1',
  callId: `call-${++n}`,
  projectId: null,
  mode: 'work',
  origin: 'model',
  profile: { id: 'workspace', hash: 'h' },
  signal: new AbortController().signal,
  ...over,
});

describe('browser routes', () => {
  it('need a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/browser/status'],
      ['GET', '/api/v1/browser/sites'],
      ['PUT', '/api/v1/browser/domains'],
      ['GET', '/api/v1/browser/actions'],
      ['POST', '/api/v1/browser/signins/x/submit'],
      ['DELETE', '/api/v1/browser/logins/x'],
    ] as const) {
      const r = await app.inject({ method, url, payload: {} });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('report the browser status and register a diagnostics probe', async () => {
    expect((await call('GET', '/api/v1/browser/status')).json()).toEqual({
      available: true,
      detail: 'fake browser',
      driver: 'fake',
      egress: 'not_required',
    });
    expect((await diagnostics.collect()).browser).toMatchObject({ available: true });
  });

  it('manage sites: levels, developer-protocol mode under policy, removal', async () => {
    expect((await call('PUT', '/api/v1/browser/sites', { pattern: '*' })).statusCode).toBe(400);
    expect(
      (await call('PUT', '/api/v1/browser/sites', { pattern: 'https://a.example/x' })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', '/api/v1/browser/sites', { pattern: 'a.example', extra: 1 })).statusCode,
    ).toBe(400);
    const put = await call('PUT', '/api/v1/browser/sites', {
      pattern: 'A.Example',
      level: 'always_allow',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      pattern: 'a.example',
      access: 'allow',
      level: 'always_allow',
      devProtocol: false,
    });
    const dev = await call('PATCH', '/api/v1/browser/sites/a.example', { devProtocol: true });
    expect(dev.json()).toMatchObject({ devProtocol: true });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['browser.site.set', 'browser.devprotocol.enabled']),
    );
    settings['browser.devProtocol'] = false;
    const denied = await call('PUT', '/api/v1/browser/sites', {
      pattern: 'b.example',
      devProtocol: true,
    });
    expect(denied.statusCode).toBe(403);
    expect((await call('GET', '/api/v1/browser/sites')).json().items).toHaveLength(1);
    expect(
      (await call('PATCH', '/api/v1/browser/sites/nope.example', { level: 'always_ask' }))
        .statusCode,
    ).toBe(404);
    expect((await call('DELETE', '/api/v1/browser/sites/a.example')).json()).toEqual({ ok: true });
    expect((await call('DELETE', '/api/v1/browser/sites/a.example')).statusCode).toBe(404);
    expect(audit.some((a) => a.action === 'browser.site.removed')).toBe(true);
  });

  it('replace the domain lists', async () => {
    const r = await call('PUT', '/api/v1/browser/domains', {
      allow: ['docs.example', '*.cdn.example'],
      deny: ['evil.example'],
    });
    expect(r.json()).toEqual({ allow: ['*.cdn.example', 'docs.example'], deny: ['evil.example'] });
    expect((await call('GET', '/api/v1/browser/domains')).json()).toEqual(r.json());
    expect((await call('PUT', '/api/v1/browser/domains', { allow: ['*'] })).statusCode).toBe(400);
  });

  it('list sessions and recorded actions with their screenshots, and close a session', async () => {
    await call('PUT', '/api/v1/browser/sites', { pattern: 'a.example', level: 'always_allow' });
    expect(
      (await area.service.navigate(browserCall({ callId: 'nav-1' }), 'https://a.example/')).ok,
    ).toBe(true);
    const sessions = (await call('GET', '/api/v1/browser/sessions')).json().items;
    expect(sessions).toEqual([
      expect.objectContaining({
        computerId: `thread-${WORK}`,
        state: 'running',
        host: 'a.example',
      }),
    ]);
    const actions = (
      await call('GET', `/api/v1/browser/actions?threadId=${WORK}&callId=nav-1`)
    ).json().items;
    expect(actions).toEqual([
      expect.objectContaining({ action: 'navigate', before: true, after: true }),
    ]);
    const shot = await call('GET', `/api/v1/browser/actions/${actions[0].id}/screenshots/after`);
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    expect(shot.rawPayload.equals(PNG)).toBe(true);
    expect(
      (await call('GET', `/api/v1/browser/actions/${actions[0].id}/screenshots/side`)).statusCode,
    ).toBe(400);
    expect((await call('GET', '/api/v1/browser/actions/nope/screenshots/after')).statusCode).toBe(
      404,
    );
    expect((await call('GET', '/api/v1/browser/actions?limit=0')).statusCode).toBe(400);
    expect((await call('DELETE', `/api/v1/browser/sessions/thread-${WORK}`)).json()).toEqual({
      ok: true,
    });
    expect((await call('DELETE', `/api/v1/browser/sessions/thread-${WORK}`)).statusCode).toBe(404);
  });

  it('take a private sign-in: the answer fills the page and is never echoed or audited', async () => {
    await call('PUT', '/api/v1/browser/sites', { pattern: 'login.example' });
    expect((await area.service.navigate(browserCall(), 'https://login.example/')).ok).toBe(true);
    const asking = area.service.signIn(browserCall(), 'for the invoices');
    let id = '';
    await vi.waitFor(async () => {
      const items = (await call('GET', `/api/v1/browser/signins?threadId=${WORK}`)).json().items;
      expect(items).toHaveLength(1);
      id = items[0].id;
    });
    expect(
      (await call('POST', `/api/v1/browser/signins/${id}/submit`, { username: 'ada' })).statusCode,
    ).toBe(400);
    const r = await call('POST', `/api/v1/browser/signins/${id}/submit`, {
      username: 'ada@example.com',
      password: 'pw-route-secret',
      save: true,
    });
    expect(r.json()).toEqual({
      state: 'completed',
      message: 'Signed in to login.example in the agent browser.',
    });
    expect(r.body).not.toContain('pw-route-secret');
    expect((await asking).ok).toBe(true);
    expect(driver.fills).toEqual(['ada@example.com', 'pw-route-secret']);
    expect(JSON.stringify(audit)).not.toContain('pw-route-secret');
    expect(audit.find((a) => a.action === 'browser.signin.submitted')?.detail).toMatchObject({
      saved: 'saved',
    });
    // Answered: a second answer is too late.
    expect(
      (await call('POST', `/api/v1/browser/signins/${id}/submit`, { username: 'a', password: 'b' }))
        .statusCode,
    ).toBe(410);
    const logins = (await call('GET', '/api/v1/browser/logins')).json().items;
    expect(logins).toEqual([
      expect.objectContaining({ host: 'login.example', username: 'ada@example.com' }),
    ]);
    expect(JSON.stringify(logins)).not.toContain('pw-route-secret');
    expect(await secrets.get(`secret://browser/login/${logins[0].id}`)).toBe('pw-route-secret');
    expect((await call('DELETE', `/api/v1/browser/logins/${logins[0].id}`)).json()).toEqual({
      ok: true,
    });
    expect(await secrets.get(`secret://browser/login/${logins[0].id}`)).toBeNull();
    expect((await call('DELETE', `/api/v1/browser/logins/${logins[0].id}`)).statusCode).toBe(404);
    // Cancel.
    const again = area.service.signIn(browserCall(), undefined);
    await vi.waitFor(async () => {
      id = (await call('GET', '/api/v1/browser/signins')).json().items[0]?.id ?? '';
      expect(id).not.toBe('');
    });
    expect((await call('POST', `/api/v1/browser/signins/${id}/cancel`)).json()).toEqual({
      ok: true,
    });
    expect(await again).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect((await call('POST', `/api/v1/browser/signins/${id}/cancel`)).statusCode).toBe(410);
  });

  it('offer the tools in Work threads, not in chats, and sweep old screenshots', async () => {
    const work = await area.tools.list(ACCOUNT, { threadId: WORK, mode: 'work' });
    expect(work.map((t) => t.descriptor.name)).toContain('browser.navigate');
    expect(await area.tools.list(ACCOUNT, { threadId: CHAT, mode: 'chat' })).toEqual([]);
    expect(sweeps).toHaveLength(1);
    sweeps[0]!();
    const ctl = area.controllerFor(ACCOUNT, 'c1');
    expect(ctl.computerId).toBe('c1');
    // Late-bound wiring does not throw.
    area.useGate(policy.gate);
    area.useReviewer({ review: () => Promise.reject(new Error('unused')) });
    area.useComputerResolver(() => Promise.resolve(null));
  });

  it('stays closed without the egress proxy by default', async () => {
    const other = await setupBrowser(context(), { driver, setTimer: () => () => undefined });
    try {
      expect(await other.service.status()).toMatchObject({ available: false, egress: 'missing' });
    } finally {
      await other.close();
    }
  });
});
