/* eslint-disable @typescript-eslint/require-await */
// The browser area (FR-086, FR-092, FR-094, FR-096, FR-098; docs/11 §4): every route needs a
// session and validates its body; site levels, developer-protocol mode (with its policy switch),
// domain lists, sessions, recorded actions and their screenshots, private sign-in through the
// routes (credentials never echoed or audited), saved logins, the diagnostics probe, the tool
// source per thread mode, and the retention sweep. M7: site levels per project or agent, the
// trace newest first with a cursor, and the console and network capture of a session.
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
const PROJECT = '01920000-0000-7000-8000-0000000000d1';
const AGENT = '01920000-0000-7000-8000-0000000000e1';
const AUTH = { 'x-account': ACCOUNT };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A small scripted browser: two pages, a sign-in form. */
class Driver implements BrowserDriver {
  readonly name = 'fake';
  readonly fills: string[] = [];
  /** The last launch's options (the test emits console and network events through them). */
  opts: DriverLaunchOptions | null = null;
  async probe() {
    return { ok: true, detail: 'fake browser' };
  }
  async launch(opts: DriverLaunchOptions): Promise<DriverSession> {
    this.opts = opts;
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
      hover: async () => undefined,
      fill: async (_ref, text) => {
        fills.push(text);
      },
      select: async () => undefined,
      press: async () => undefined,
      scroll: async () => undefined,
      waitFor: async () => true,
      screenshot: async () => new Uint8Array(PNG),
      screenshotElement: async () => new Uint8Array(PNG),
      download: async () => ({ suggestedName: 'a.txt', data: new Uint8Array([1]) }),
      upload: async () => undefined,
      evaluate: async () => 1,
      callPageTool: async () => null,
      input: async (_e: BrowserTakeoverInput) => undefined,
      storageState: async () => ({ cookies: [], origins: [] }),
      cookies: async () => [],
      recover: async () => true,
      crashState: async () => null,
      focusedSecret: async () => false,
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
  db.raw
    .prepare(
      "INSERT INTO project (id, account_id, name, kind, created_at, updated_at) VALUES (?, ?, 'Acme', 'work', ?, ?)",
    )
    .run(PROJECT, ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO agent (id, account_id, name, time_budget_s, token_budget, created_at, updated_at) VALUES (?, ?, 'Researcher', 3600, 100000, ?, ?)",
    )
    .run(AGENT, ACCOUNT, now, now);
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
      ['GET', '/api/v1/browser/site-levels'],
      ['PUT', `/api/v1/browser/sites/a.example/levels/project/${PROJECT}`],
      ['DELETE', `/api/v1/browser/sites/a.example/levels/project/${PROJECT}`],
      ['GET', '/api/v1/browser/sessions/c1/console'],
      ['GET', '/api/v1/browser/sessions/c1/network'],
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

  it('set, list and remove site levels per project or agent (M7)', async () => {
    const level = (scope: string, body: unknown, method: 'PUT' | 'DELETE' = 'PUT') =>
      call(method, `/api/v1/browser/sites/a.example/levels/${scope}`, body);
    expect((await level(`project/${PROJECT}`, { level: 'always_allow' })).statusCode).toBe(404);
    await call('PUT', '/api/v1/browser/sites', { pattern: 'a.example' });
    expect((await level(`team/${PROJECT}`, { level: 'always_allow' })).statusCode).toBe(400);
    expect((await level('project/bad%20id', { level: 'always_allow' })).statusCode).toBe(400);
    expect((await level(`project/${PROJECT}`, { level: 'sometimes' })).statusCode).toBe(400);
    expect((await level(`project/${PROJECT}`, { level: 'always_allow', x: 1 })).statusCode).toBe(
      400,
    );
    expect((await level(`agent/${PROJECT}`, { level: 'always_allow' })).statusCode).toBe(404);
    const set = await level(`project/${PROJECT}`, { level: 'always_allow' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      pattern: 'a.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    expect((await level(`agent/${AGENT}`, { level: 'always_ask' })).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/browser/sites')).json().items[0].scopedLevels).toHaveLength(
      2,
    );
    expect((await call('GET', `/api/v1/browser/site-levels?scopeKind=agent`)).json().items).toEqual(
      [expect.objectContaining({ scopeRef: AGENT, level: 'always_ask' })],
    );
    expect((await call('GET', '/api/v1/browser/site-levels?scopeKind=team')).statusCode).toBe(400);
    expect((await level(`agent/${AGENT}`, undefined, 'DELETE')).json()).toEqual({ ok: true });
    expect((await level(`agent/${AGENT}`, undefined, 'DELETE')).statusCode).toBe(404);
    expect(audit.filter((a) => a.action.startsWith('browser.site.level.'))).toEqual([
      expect.objectContaining({
        action: 'browser.site.level.set',
        resource: 'a.example',
        detail: { scopeKind: 'project', scopeRef: PROJECT, level: 'always_allow' },
      }),
      expect.objectContaining({ action: 'browser.site.level.set' }),
      expect.objectContaining({
        action: 'browser.site.level.removed',
        detail: { scopeKind: 'agent', scopeRef: AGENT },
      }),
    ]);
    // The scope of a thread comes from its project (the default resolver): typing on an Always
    // ask site runs without a card in the project's thread, where the project says Always allow.
    await call('PUT', '/api/v1/browser/sites', { pattern: 'login.example' });
    await call('PUT', `/api/v1/browser/sites/login.example/levels/project/${PROJECT}`, {
      level: 'always_allow',
    });
    db.raw.prepare('UPDATE thread SET project_id = ? WHERE id = ?').run(PROJECT, WORK);
    expect((await area.service.navigate(browserCall(), 'https://login.example/')).ok).toBe(true);
    expect((await area.service.read(browserCall())).ok).toBe(true);
    const typed = await area.service.write(browserCall(), { kind: 'type', ref: 'e1', text: 'ada' });
    expect(typed.ok).toBe(true);
    expect(driver.fills).toEqual(['ada']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM approval').get()).toEqual({ n: 0 });
  });

  it("removes a deleted project's or agent's site levels, audited as the system (M7)", async () => {
    const OTHER = '01920000-0000-7000-8000-0000000000d2';
    const at = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO project (id, account_id, name, kind, created_at, updated_at) VALUES (?, ?, 'Other', 'work', ?, ?)",
      )
      .run(OTHER, ACCOUNT, at, at);
    for (const site of ['a.example', 'b.example'])
      await call('PUT', '/api/v1/browser/sites', { pattern: site });
    for (const [site, scope] of [
      ['a.example', `project/${PROJECT}`],
      ['b.example', `project/${PROJECT}`],
      ['a.example', `project/${OTHER}`],
      ['a.example', `agent/${AGENT}`],
    ] as const)
      expect(
        (
          await call('PUT', `/api/v1/browser/sites/${site}/levels/${scope}`, {
            level: 'always_allow',
          })
        ).statusCode,
      ).toBe(200);
    type Levels = { items: { pattern: string; scopeKind: string; scopeRef: string }[] };
    const levels = async () =>
      (await call('GET', '/api/v1/browser/site-levels'))
        .json<Levels>()
        .items.map((l) => `${l.pattern} ${l.scopeKind}/${l.scopeRef}`);
    expect(await levels()).toHaveLength(4);
    // Another account's deletion of the same id touches nothing here.
    await events.emit({
      name: 'project.deleted',
      actor: 'system',
      accountId: '01920000-0000-7000-8000-000000000002',
      payload: { projectId: PROJECT },
    });
    await events.emit({
      name: 'project.deleted',
      actor: 'system',
      accountId: ACCOUNT,
      payload: { projectId: PROJECT },
    });
    await vi.waitFor(async () => expect(await levels()).toHaveLength(2));
    expect((await levels()).sort()).toEqual([
      `a.example agent/${AGENT}`,
      `a.example project/${OTHER}`,
    ]);
    await events.emit({
      name: 'agent.deleted',
      actor: 'user',
      accountId: ACCOUNT,
      payload: { agentId: AGENT },
    });
    await vi.waitFor(async () => expect(await levels()).toEqual([`a.example project/${OTHER}`]));
    // The scoped policy rules went with them: only the remaining level's rule is left.
    const rules = db.raw
      .prepare("SELECT COUNT(*) AS n FROM policy_rule WHERE action_match LIKE '%browser.act:%'")
      .get() as { n: number };
    expect(rules.n).toBe(1);
    expect(
      audit.filter((a) => a.action === 'browser.site.level.removed' && a.actor === 'system'),
    ).toEqual([
      expect.objectContaining({
        resource: null,
        detail: { scopeKind: 'project', scopeRef: PROJECT, count: 2, reason: 'project_deleted' },
      }),
      expect.objectContaining({
        detail: { scopeKind: 'agent', scopeRef: AGENT, count: 1, reason: 'agent_deleted' },
      }),
    ]);
  });

  it('list the trace newest first with a cursor, and show what a session captured (M7)', async () => {
    expect((await call('GET', `/api/v1/browser/sessions/thread-${WORK}/console`)).statusCode).toBe(
      404,
    );
    await call('PUT', '/api/v1/browser/sites', { pattern: 'a.example', level: 'always_allow' });
    for (let i = 0; i < 3; i++)
      expect((await area.service.navigate(browserCall(), 'https://a.example/')).ok).toBe(true);
    const first = (await call('GET', `/api/v1/browser/actions?threadId=${WORK}&limit=2`)).json();
    expect(first.items).toHaveLength(2);
    expect(first.items[0].createdAt >= first.items[1].createdAt).toBe(true);
    const rest = (
      await call(
        'GET',
        `/api/v1/browser/actions?threadId=${WORK}&limit=2&cursor=${first.nextCursor}`,
      )
    ).json();
    expect(rest).toMatchObject({ nextCursor: null });
    expect(rest.items).toHaveLength(1);
    expect((await call('GET', '/api/v1/browser/actions?cursor=bogus')).statusCode).toBe(400);
    driver.opts!.onConsole?.({
      level: 'error',
      text: 'Authorization: Bearer abcdefabcdefabcdef',
      source: 'console',
    });
    driver.opts!.onNetwork?.({
      phase: 'request',
      id: 'r1',
      method: 'GET',
      url: 'https://a.example/api?token=t0k',
      resourceType: 'fetch',
      navigation: false,
      headers: { cookie: 'sid=1' },
    });
    const con = (await call('GET', `/api/v1/browser/sessions/thread-${WORK}/console`)).json();
    expect(con).toMatchObject({ dropped: 0, items: [expect.objectContaining({ level: 'error' })] });
    expect(JSON.stringify(con)).not.toContain('abcdefabcdefabcdef');
    const net = (
      await call('GET', `/api/v1/browser/sessions/thread-${WORK}/network?limit=5`)
    ).json();
    expect(net.items[0]).toMatchObject({
      url: 'https://a.example/api?token=[REDACTED]',
      requestHeaders: { cookie: '[REDACTED]' },
    });
    expect(
      (await call('GET', `/api/v1/browser/sessions/thread-${WORK}/network?limit=0`)).statusCode,
    ).toBe(400);
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
    area.useScopeResolver(() => Promise.resolve({ projectId: null, agentId: null }));
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
