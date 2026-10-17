// The tools area in M4 (FR-028, FR-035, FR-046, FR-197): hooks and skills reach the
// ChatService through `chatOptions` and the runtime, GET /threads/:id/suggestions, and a
// project's folders as tool roots.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError, type HookEvent } from '@nova/shared';
import {
  ChatService,
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  UnavailableSandbox,
  allowAllGate,
  noopNotifier,
  type HookDispatcher,
  type HookInput,
  type HookOutcome,
  type SkillCatalogProvider,
} from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupTools, type ToolsArea } from '../src/tools.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000aa';
const AUTH = { 'x-test-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let config: HubConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-loop-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface LoopEnv {
  app: FastifyInstance;
  area: ToolsArea;
  chat: ChatService;
  threads: ThreadService;
  mock: MockProvider;
  settings: Record<string, unknown>;
  calls: { event: HookEvent; input: HookInput }[];
  close: () => Promise<void>;
}

async function loopEnv(
  opts: {
    hooks?: (event: HookEvent, input: HookInput) => HookOutcome;
    skills?: SkillCatalogProvider;
    appContext?: (accountId: string, threadId: string) => Promise<string | null>;
  } = {},
): Promise<LoopEnv> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const mock = new MockProvider({ id: 'mock' });
  const registry = new ProviderRegistry({
    db,
    secrets,
    factory: (input) => (input.row.provider === 'mock' ? mock : undefined),
  });
  await registry.ensureDefaultProvider(ACCOUNT);
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const settings: Record<string, unknown> = { 'chat.suggestions': true };
  const defaults: Record<string, unknown> = {
    'search.searxngUrl': null,
    'tools.permissionProfile': 'workspace',
    'tools.roots': [],
    'tools.deferBudget': { tools: 40, schemaTokens: 8000 },
  };
  const ctx = {
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    events,
    secrets,
    dataDir: config.dataDir,
    registry,
    router,
    nodes: new NodeService({ db, secrets, events }),
    threads,
    setting: (key: string) => Promise.resolve(key in settings ? settings[key] : defaults[key]),
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers['x-test-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const calls: LoopEnv['calls'] = [];
  const hooks: HookDispatcher | undefined = opts.hooks
    ? {
        dispatch: (event, input) => {
          calls.push({ event, input });
          return Promise.resolve(opts.hooks!(event, input));
        },
      }
    : undefined;
  const area = await setupTools({
    ...ctx,
    gate: allowAllGate,
    sources: opts.skills ? [opts.skills.tools] : [],
    audit: { append: () => Promise.resolve() },
    notifier: noopNotifier,
    sandbox: new UnavailableSandbox(),
    ...(hooks ? { hooks } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.appContext ? { appContext: opts.appContext } : {}),
  });
  const chat = new ChatService({
    db,
    router,
    threads,
    events,
    dataDir: config.dataDir,
    deltaIntervalMs: 0,
    flushIntervalMs: 20,
    ...area.chatOptions,
  });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return {
    app,
    area,
    chat,
    threads,
    mock,
    settings,
    calls,
    close: async () => {
      await chat.shutdown();
      await app.close();
      await area.close();
    },
  };
}

let e: LoopEnv;
afterEach(async () => {
  await e.close();
});

describe('hooks and skills reach the loop (FR-046, FR-197)', () => {
  it('chatOptions carry the hooks and skills; the runtime runs tool hooks', async () => {
    const skills: SkillCatalogProvider = {
      catalogSection: () => Promise.resolve('## Skills\n- greet: Say hello.'),
      resolve: (_a, _p, name) =>
        Promise.resolve(
          name === 'greet'
            ? {
                skillId: 'skill:user:greet',
                name,
                body: 'Say hello warmly.',
                allowedTools: [],
                files: [],
              }
            : null,
        ),
      tools: { source: 'plugin', list: () => Promise.resolve([]) },
    };
    e = await loopEnv({ hooks: () => ({ context: [] }), skills });
    expect(e.area.chatOptions).toMatchObject({ tools: e.area.runtime, skills });
    expect(e.area.chatOptions.hooks).toBeDefined();
    const t = await e.threads.create(ACCOUNT, {});
    await e.chat.send(ACCOUNT, t.id, { text: '/greet\n/tool fs.list {}' });
    await e.chat.idle();
    expect(e.calls.map((c) => c.event)).toEqual([
      'session.start',
      'prompt.submit',
      'tool.pre',
      'tool.post',
      'stop',
    ]);
    const first = e.mock.requests[0]!;
    const system = first.messages[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join(
      '',
    );
    expect(system).toContain('## Skills\n- greet: Say hello.');
    const user = first.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(user).toContain('## Skill: greet');
  });

  it('a tool.pre block refuses a UI invoke too', async () => {
    e = await loopEnv({
      hooks: (event) =>
        event === 'tool.pre'
          ? { context: [], block: { reason: 'read-only day', hookId: 'hook:user.ro' } }
          : { context: [] },
    });
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/fs.list/invoke',
      headers: AUTH,
      payload: { args: {} },
    });
    expect(res.json()).toMatchObject({
      ok: false,
      error: { code: 'denied', message: 'A hook blocked this call: read-only day' },
    });
  });

  it('without hooks or skills the chat options carry only the tools', async () => {
    e = await loopEnv();
    expect(Object.keys(e.area.chatOptions)).toEqual(['tools']);
  });

  it("MCP Apps' model context reaches the turn through appContext (FR-198)", async () => {
    e = await loopEnv({ appContext: () => Promise.resolve('Board: 2 cards') });
    const t = await e.threads.create(ACCOUNT, {});
    await e.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await e.chat.idle();
    const user = e.mock.requests[0]!.messages.filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(user).toMatch(/<untrusted_data source="mcp"[^>]*>\nBoard: 2 cards\n/);
  });
});

describe('GET /threads/:id/suggestions (FR-028)', () => {
  it('needs a session, a known thread, and the setting', async () => {
    e = await loopEnv();
    const t = await e.threads.create(ACCOUNT, {});
    const url = `/api/v1/threads/${t.id}/suggestions`;
    expect((await e.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const missing = await e.app.inject({
      method: 'GET',
      url: '/api/v1/threads/01920000-0000-7000-8000-0000000000ff/suggestions',
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    // No completed turn yet.
    expect((await e.app.inject({ method: 'GET', url, headers: AUTH })).json()).toEqual({
      items: [],
    });

    await e.chat.send(ACCOUNT, t.id, { text: 'hello' });
    await e.chat.idle();
    const on = await e.app.inject({ method: 'GET', url, headers: AUTH });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({
      items: ['Can you give me an example?', 'What should I do next?', 'Explain that more simply'],
    });
    e.settings['chat.suggestions'] = false;
    expect((await e.app.inject({ method: 'GET', url, headers: AUTH })).json()).toEqual({
      items: [],
    });
  });
});

describe('project folders are tool roots (FR-035)', () => {
  it("adds a project's folders to its chats' roots, capped by the profile", async () => {
    e = await loopEnv();
    const folder = join(dir, 'code');
    mkdirSync(folder, { recursive: true });
    const project = '01920000-0000-7000-8000-0000000000b1';
    // Without folders: the workspace only (the project_folder table, empty or absent).
    const before = await e.area.runtime.scopeFor(ACCOUNT, null, project);
    expect(before.roots.map((r) => r.label)).toEqual(['Workspace']);
    e.area.useProjectFolders((id) =>
      Promise.resolve(id === project ? [{ path: folder, access: 'write' as const }] : []),
    );
    const scope = await e.area.runtime.scopeFor(ACCOUNT, null, project);
    expect(scope.roots.map((r) => [r.label, r.access])).toEqual([
      ['Workspace', 'write'],
      ['code', 'write'],
    ]);
    expect(scope.profile.hash).not.toBe(before.profile.hash);
    // Another project's chats do not get them; the read-only profile caps them.
    const other = await e.area.runtime.scopeFor(ACCOUNT, null, null);
    expect(other.roots).toHaveLength(1);
    e.settings['tools.permissionProfile'] = 'read-only';
    const ro = await e.area.runtime.scopeFor(ACCOUNT, null, project);
    expect(ro.roots.map((r) => r.access)).toEqual(['read', 'read']);
    // A failing source adds nothing.
    e.area.useProjectFolders(() => Promise.reject(new Error('locked')));
    expect((await e.area.runtime.scopeFor(ACCOUNT, null, project)).roots).toHaveLength(1);
  });
});
