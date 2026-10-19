// The flagged area's routes and tool registration (FR-202, FR-203): sessions on every route, every
// route and `script.run` absent while their flags are off, script runs with their nested calls,
// adapters (validated; one that cannot route permissions refused; secrets only as references),
// and delegations from a Code session to a fake external agent whose requests pass the real
// policy gate through the real tool runtime.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type LightMyRequestResponse,
} from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type AgentAdapterView,
  type DelegationView,
  type ScriptRunView,
  type SettingKey,
} from '@nova/shared';
import {
  PolicyGate,
  PolicyStore,
  ToolRegistry,
  ToolRuntime,
  execTools,
  fsTools,
  type AgentLaunch,
  type AuditRecord,
  type BuiltinTool,
  type LineTransport,
  type SandboxClient,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupFlagged, type FlaggedArea } from '../src/flagged.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';
const OTHER = '01920000-0000-7000-8000-0000000000c2';
const THREAD = '01920000-0000-7000-8000-0000000000c3';
const TURN = '01920000-0000-7000-8000-0000000000c4';
const SESSION = '01920000-0000-7000-8000-0000000000c5';
const AUTH = { 'x-account': ACCOUNT };
const AGENT = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/fake-acp-agent.mjs', import.meta.url),
);

/** Test-only launcher: the fake agent as a child process (the Hub's runs it in the sandbox). */
function processLauncher(l: AgentLaunch): Promise<LineTransport> {
  const child = spawn(process.execPath, [AGENT], {
    env: { PATH: process.env.PATH ?? '', ...l.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const rl = createInterface({ input: child.stdout });
  const closers: ((r: string) => void)[] = [];
  child.on('exit', (code) => closers.forEach((cb) => cb(`exited ${code}`)));
  child.stdin.on('error', () => undefined);
  return Promise.resolve({
    send: (line) => void child.stdin.write(`${line}\n`),
    onLine: (cb) => void rl.on('line', cb),
    onClose: (cb) => void closers.push(cb),
    close: () => Promise.resolve(void child.kill('SIGKILL')),
  });
}

const sandbox: SandboxClient = {
  substrate: 'container',
  available: () => Promise.resolve({ ok: true, detail: '' }),
  exec: (req) => Promise.resolve({ status: 'exited', exitCode: 0, output: `ran: ${req.cmd}` }),
  poll: () => Promise.reject(new Error('none')),
  write: () => Promise.resolve(),
  killTurn: () => Promise.resolve(),
};

interface Env {
  app: FastifyInstance;
  area: FlaggedArea;
  db: NovaDatabase;
  events: EventStore;
  gate: PolicyGate;
  runtime: ToolRuntime;
  audit: AuditRecord[];
  settings: Partial<Record<SettingKey, unknown>>;
  diagnostics: DiagnosticsRegistry;
  workspace: string;
  approvals: string[];
  call: (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

let hub: Env;

async function makeHub(opts: { sandboxLauncher?: boolean } = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-flagged-'));
  const dataDir = join(dir, 'data');
  const workspace = join(dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'code', 'idle', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO turn (id, thread_id, idx, execution_location, started_at, created_at, updated_at) VALUES (?, ?, 0, 'hub', ?, ?, ?)",
    )
    .run(TURN, THREAD, now, now, now);
  db.raw
    .prepare(
      'INSERT INTO code_session (id, account_id, thread_id, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(SESSION, ACCOUNT, THREAD, workspace, now, now);
  const events = new EventStore(db);
  const approvals: string[] = [];
  events.bus.subscribe('approval.requested', (e) =>
    approvals.push((e.payload as { approvalId: string }).approvalId),
  );
  const audit: AuditRecord[] = [];
  const settings: Partial<Record<SettingKey, unknown>> = {};
  const setting = (key: SettingKey) =>
    Promise.resolve((key in settings ? settings[key] : SETTINGS[key].default) as never);
  const diagnostics = new DiagnosticsRegistry();
  const ctx = {
    config: { version: '0.0.0-test' },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
    dataDir,
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {
      row: (accountId: string, id: string) => {
        const r = db.raw
          .prepare('SELECT id FROM thread WHERE id = ? AND account_id = ?')
          .get(id, accountId);
        if (!r) return Promise.reject(new NovaError('not_found', 'thread not found'));
        return Promise.resolve(r);
      },
    },
    setting,
    accountOf: (req: FastifyRequest) => {
      const a = req.headers['x-account'];
      if (a !== ACCOUNT && a !== OTHER)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(a);
    },
    diagnostics,
  } as unknown as Parameters<typeof setupFlagged>[0];
  const area = await setupFlagged(ctx, {
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    // The real launcher runs agents in the sandbox the session routes to (finding 3 tests).
    ...(opts.sandboxLauncher ? {} : { launcher: processLauncher }),
  });
  const gate = new PolicyGate({
    store: new PolicyStore({ db }),
    events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    notifier: { notify: () => Promise.resolve() },
    setting,
    dataDir,
    home: join(dir, 'home'),
  });
  const read: BuiltinTool = {
    descriptor: {
      name: 'demo.read',
      title: 'Read',
      description: 'read',
      source: 'builtin',
      inputSchema: { type: 'object' },
      annotations: { readOnly: true },
    },
    origin: 'file',
    handler: () => Promise.resolve({ ok: true, content: [{ type: 'text', text: 'demo text' }] }),
  };
  const paths = { denied: [join(dataDir, 'vault')], allowed: [workspace] };
  const builtins = [read, ...fsTools({ paths }), ...execTools({ paths })];
  const runtime = new ToolRuntime({
    db,
    events,
    gate,
    registry: new ToolRegistry({
      sources: [{ source: 'builtin', list: () => Promise.resolve(builtins) }, area.tools],
    }),
    sandbox,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    scope: () =>
      Promise.resolve({
        roots: [{ path: workspace, access: 'write', label: 'Session' }],
        profile: { id: 'workspace', hash: 'h' },
        network: 'off',
      }),
    paths,
  });
  area.useRuntime(runtime);
  area.useGate(gate);
  area.useSandbox(() => sandbox);
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return {
    app,
    area,
    db,
    events,
    gate,
    runtime,
    audit,
    settings,
    diagnostics,
    workspace,
    approvals,
    call: (method, url, payload, headers = AUTH) =>
      app.inject({
        method,
        url,
        headers,
        ...(payload !== undefined ? { payload: payload as never } : {}),
      }),
    close: async () => {
      await area.close();
      await runtime.close();
      await gate.close();
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

beforeEach(async () => {
  hub = await makeHub();
});
afterEach(() => hub.close());

const ROUTES: [string, string][] = [
  ['GET', '/api/v1/scripts/runs?threadId=x'],
  ['GET', '/api/v1/scripts/runs'],
  ['GET', '/api/v1/scripts/runs/x'],
  ['GET', '/api/v1/agent-adapters'],
  ['POST', '/api/v1/agent-adapters'],
  ['GET', '/api/v1/agent-adapters/x'],
  ['PATCH', '/api/v1/agent-adapters/x'],
  ['DELETE', '/api/v1/agent-adapters/x'],
  ['POST', '/api/v1/agent-adapters/x/check'],
  ['GET', '/api/v1/code/sessions/x/delegations'],
  ['POST', '/api/v1/code/sessions/x/delegations'],
  ['GET', '/api/v1/delegations/x'],
  ['POST', '/api/v1/delegations/x/cancel'],
];

const ADAPTER = {
  name: 'Fake',
  command: 'fake-agent',
  args: ['--acp'],
  env: { TOKEN: 'abc-secret' },
  permissionRouting: 'client',
};

describe('flagged routes', () => {
  it('require a session on every route', async () => {
    for (const [method, url] of ROUTES) {
      const res = await hub.app.inject({
        method: method as 'GET',
        url,
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('are absent, and script.run unlisted, while the flags are off', async () => {
    for (const [method, url] of ROUTES) {
      const res = await hub.call(method as 'GET', url, method === 'GET' ? undefined : ADAPTER);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const names = async () =>
      (await hub.runtime.registry.list(ACCOUNT)).map((t) => t.descriptor.name);
    expect(await names()).not.toContain('script.run');
    hub.settings['scripts.enabled'] = true;
    expect(await names()).toContain('script.run');
    expect(await hub.diagnostics.collect()).toMatchObject({
      flagged: { scripts: true, externalAgents: false, adapters: 0 },
    });
  });
});

describe('script runs', () => {
  it('lists a thread’s script runs with their nested calls', async () => {
    hub.settings['scripts.enabled'] = true;
    const msg = uuidv7();
    const now = new Date().toISOString();
    hub.db.raw
      .prepare(
        "INSERT INTO message (id, thread_id, turn_id, role, created_at, updated_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
      )
      .run(msg, THREAD, TURN, now, now);
    const turn = await hub.runtime.beginTurn({
      accountId: ACCOUNT,
      threadId: THREAD,
      turnId: TURN,
      projectId: null,
      mode: 'code',
      signal: new AbortController().signal,
    });
    const out = await turn.call({
      call: {
        id: 'm1',
        name: 'script.run',
        args: { code: 'return await tools.call("demo.read")' },
      },
      messageId: msg,
      partIdx: 0,
      provenance: { userInstruction: { messageId: 'u', accountId: ACCOUNT }, taint: [] },
    });
    expect(out.status).toBe('ok');
    const list = await hub.call('GET', `/api/v1/scripts/runs?threadId=${THREAD}`);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: ScriptRunView[] }>().items).toEqual([
      expect.objectContaining({ id: out.callId, status: 'ok', calls: 1 }),
    ]);
    const one = await hub.call('GET', `/api/v1/scripts/runs/${out.callId}`);
    expect(one.json<ScriptRunView>().nested).toEqual([
      expect.objectContaining({ tool: 'demo.read', status: 'ok', decision: 'allow' }),
    ]);
    expect(
      (
        await hub.call('GET', `/api/v1/scripts/runs/${out.callId}`, undefined, {
          'x-account': OTHER,
        })
      ).statusCode,
    ).toBe(404);
    expect((await hub.call('GET', '/api/v1/scripts/runs?thread=x')).statusCode).toBe(400);
    expect(
      (
        await hub.call('GET', `/api/v1/scripts/runs?threadId=${THREAD}`, undefined, {
          'x-account': OTHER,
        })
      ).statusCode,
    ).toBe(404);
    expect(hub.audit.some((a) => a.action === 'script.call')).toBe(true);
  });
});

describe('script runs across threads (M7)', () => {
  it('lists the account’s runs newest first, paged without skipping a shared timestamp', async () => {
    hub.settings['scripts.enabled'] = true;
    const at = (s: number) => `2026-10-01T00:00:0${s}.000Z`;
    const other = uuidv7();
    const gone = uuidv7();
    for (const [id, account] of [
      [other, ACCOUNT],
      [gone, ACCOUNT],
    ] as const)
      hub.db.raw
        .prepare(
          "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'chat', 'idle', ?, ?)",
        )
        .run(id, account, at(0), at(0));
    hub.db.raw.prepare('UPDATE thread SET deleted_at = ? WHERE id = ?').run(at(9), gone);
    const run = (id: string, threadId: string | null, created: string, account = ACCOUNT) =>
      hub.db.raw
        .prepare(
          `INSERT INTO script_run (id, account_id, thread_id, code_sha256, status, created_at)
           VALUES (?, ?, ?, 'h', 'ok', ?)`,
        )
        .run(id, account, threadId, created);
    // Three runs share one timestamp across two threads; one is in a deleted thread, one is
    // another account's.
    run('r1', THREAD, at(1));
    run('r2', other, at(2));
    run('r3', THREAD, at(2));
    run('r4', null, at(2));
    run('r5', THREAD, at(3));
    run('r6', gone, at(4));
    run('r7', THREAD, at(5), OTHER);
    type Page = { items: ScriptRunView[]; nextCursor: string | null };
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await hub.call(
        'GET',
        `/api/v1/scripts/runs?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      const page: Page = res.json<Page>();
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    // One thread's runs are paged the same way.
    const mine = await hub.call('GET', `/api/v1/scripts/runs?threadId=${THREAD}&limit=1`);
    expect(mine.json<Page>().items.map((r) => r.id)).toEqual(['r5']);
    const next = await hub.call(
      'GET',
      `/api/v1/scripts/runs?threadId=${THREAD}&limit=5&cursor=${mine.json<Page>().nextCursor}`,
    );
    expect(next.json<Page>()).toEqual({
      items: [expect.objectContaining({ id: 'r3' }), expect.objectContaining({ id: 'r1' })],
      nextCursor: null,
    });
    // Another account sees only its own; a bad cursor or limit is refused.
    const theirs = await hub.call('GET', '/api/v1/scripts/runs', undefined, { 'x-account': OTHER });
    expect(theirs.json<Page>().items.map((r) => r.id)).toEqual(['r7']);
    expect((await hub.call('GET', '/api/v1/scripts/runs?cursor=nope')).statusCode).toBe(400);
    expect((await hub.call('GET', '/api/v1/scripts/runs?limit=0')).statusCode).toBe(400);
  });
});

describe('agent adapters', () => {
  beforeEach(() => {
    hub.settings['externalAgents.enabled'] = true;
  });

  it('validates bodies and refuses an adapter that cannot route permissions', async () => {
    for (const bad of [
      { ...ADAPTER, command: 'rm -rf /' },
      { ...ADAPTER, extra: 1 },
      { ...ADAPTER, permissionRouting: undefined },
      { ...ADAPTER, env: { 'BAD NAME': 'x' } },
      { ...ADAPTER, network: ['*'] },
    ]) {
      const res = await hub.call('POST', '/api/v1/agent-adapters', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const refused = await hub.call('POST', '/api/v1/agent-adapters', {
      ...ADAPTER,
      permissionRouting: 'agent',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'permission_routing',
    );
  });

  it('creates, lists, edits and deletes, with secrets only as references', async () => {
    const res = await hub.call('POST', '/api/v1/agent-adapters', ADAPTER);
    expect(res.statusCode).toBe(201);
    const a = res.json<AgentAdapterView>();
    expect(a.env.TOKEN).toMatch(/^secret:\/\/agent-adapter\//);
    expect(res.body).not.toContain('abc-secret');
    expect(
      (await hub.call('GET', '/api/v1/agent-adapters')).json<{ items: AgentAdapterView[] }>().items,
    ).toHaveLength(1);
    expect(
      (await hub.call('GET', '/api/v1/agent-adapters', undefined, { 'x-account': OTHER })).json<{
        items: AgentAdapterView[];
      }>().items,
    ).toHaveLength(0);
    const patched = await hub.call('PATCH', `/api/v1/agent-adapters/${a.id}`, { enabled: false });
    expect(patched.json<AgentAdapterView>().enabled).toBe(false);
    expect(
      (await hub.call('PATCH', `/api/v1/agent-adapters/${a.id}`, { command: 'x' })).statusCode,
    ).toBe(400);
    expect(
      (
        await hub.call('DELETE', `/api/v1/agent-adapters/${a.id}`, undefined, {
          'x-account': OTHER,
        })
      ).statusCode,
    ).toBe(404);
    expect((await hub.call('DELETE', `/api/v1/agent-adapters/${a.id}`)).statusCode).toBe(200);
    expect((await hub.call('GET', `/api/v1/agent-adapters/${a.id}`)).statusCode).toBe(404);
    expect(JSON.stringify(hub.audit)).not.toContain('abc-secret');
  });

  it('checks an adapter in a session and delegates a task whose write passes the gate', async () => {
    const a = (await hub.call('POST', '/api/v1/agent-adapters', ADAPTER)).json<AgentAdapterView>();
    const check = await hub.call('POST', `/api/v1/agent-adapters/${a.id}/check`, {
      sessionId: SESSION,
    });
    expect(check.json()).toMatchObject({ ok: true, agent: { name: 'fake-agent' } });
    const file = join(hub.workspace, 'out.md');
    const before = hub.approvals.length;
    const res = await hub.call('POST', `/api/v1/code/sessions/${SESSION}/delegations`, {
      adapterId: a.id,
      prompt: `edit ${file} done by the agent`,
    });
    expect(res.statusCode).toBe(202);
    const d = res.json<DelegationView>();
    expect(d).toMatchObject({ status: 'starting', adapterName: 'Fake', threadId: THREAD });
    await vi.waitFor(() => expect(hub.approvals.length).toBeGreaterThan(before), {
      timeout: 10_000,
    });
    await hub.gate.decide(ACCOUNT, { approvalId: hub.approvals.at(-1)!, decision: 'allow_once' });
    await hub.area.externalAgents.whenDone(d.id);
    const done = (await hub.call('GET', `/api/v1/delegations/${d.id}`)).json<DelegationView>();
    expect(done).toMatchObject({ status: 'completed', output: 'wrote it', operations: 1 });
    expect(readFileSync(file, 'utf8')).toBe('done by the agent');
    const list = await hub.call('GET', `/api/v1/code/sessions/${SESSION}/delegations`);
    expect(list.json<{ items: DelegationView[] }>().items.map((x) => x.id)).toEqual([d.id]);
    expect(
      (await hub.call('GET', `/api/v1/delegations/${d.id}`, undefined, { 'x-account': OTHER }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await hub.call('POST', `/api/v1/code/sessions/${SESSION}/delegations`, {
          adapterId: a.id,
          prompt: '',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hub.call('POST', '/api/v1/code/sessions/nope/delegations', {
          adapterId: a.id,
          prompt: 'think',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('cancels a delegation', async () => {
    const a = (await hub.call('POST', '/api/v1/agent-adapters', ADAPTER)).json<AgentAdapterView>();
    const d = (
      await hub.call('POST', `/api/v1/code/sessions/${SESSION}/delegations`, {
        adapterId: a.id,
        prompt: 'hang',
      })
    ).json<DelegationView>();
    await vi.waitFor(
      async () =>
        expect(
          (await hub.call('GET', `/api/v1/delegations/${d.id}`)).json<DelegationView>().status,
        ).toBe('running'),
      { timeout: 10_000 },
    );
    const c = await hub.call('POST', `/api/v1/delegations/${d.id}/cancel`);
    expect(c.json<DelegationView>()).toMatchObject({ status: 'cancelled' });
    expect(hub.events.bus).toBeDefined();
  });
});

describe('M7 review fixes in the Hub area', () => {
  beforeEach(() => {
    hub.settings['externalAgents.enabled'] = true;
  });

  it('stops running delegations when the flag goes off, and still reads and cancels them', async () => {
    const a = (await hub.call('POST', '/api/v1/agent-adapters', ADAPTER)).json<AgentAdapterView>();
    const d = (
      await hub.call('POST', `/api/v1/code/sessions/${SESSION}/delegations`, {
        adapterId: a.id,
        prompt: 'hang',
      })
    ).json<DelegationView>();
    await vi.waitFor(
      async () =>
        expect(
          (await hub.call('GET', `/api/v1/delegations/${d.id}`)).json<DelegationView>().status,
        ).toBe('running'),
      { timeout: 10_000 },
    );
    hub.settings['externalAgents.enabled'] = false;
    await hub.events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: ACCOUNT,
      payload: { key: 'externalAgents.enabled', scope: 'global' },
    });
    await vi.waitFor(() => expect(hub.area.externalAgents.running).toBe(0), { timeout: 15_000 });
    const got = await hub.call('GET', `/api/v1/delegations/${d.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json<DelegationView>()).toMatchObject({
      status: 'cancelled',
      error: 'external agents were turned off',
    });
    expect((await hub.call('POST', `/api/v1/delegations/${d.id}/cancel`)).statusCode).toBe(200);
    expect((await hub.call('GET', '/api/v1/agent-adapters')).statusCode).toBe(404);
    expect(hub.audit.some((r) => r.action === 'delegation.cancel')).toBe(true);
  }, 30_000);
});

describe('M7 review fix: agents need a real sandbox', () => {
  it('refuses a session whose environment runs on another machine, wired or not', async () => {
    await hub.close();
    hub = await makeHub({ sandboxLauncher: true });
    hub.settings['externalAgents.enabled'] = true;
    const now = new Date().toISOString();
    const envId = uuidv7();
    hub.db.raw
      .prepare(
        "INSERT INTO environment (id, account_id, kind, label, created_at, updated_at) VALUES (?, ?, 'ssh', 'Box', ?, ?)",
      )
      .run(envId, ACCOUNT, now, now);
    hub.db.raw
      .prepare('UPDATE code_session SET environment_id = ? WHERE id = ?')
      .run(envId, SESSION);
    const a = (await hub.call('POST', '/api/v1/agent-adapters', ADAPTER)).json<AgentAdapterView>();
    // Without the routing wired, the session's SSH environment means no sandbox (fail closed).
    const check = await hub.call('POST', `/api/v1/agent-adapters/${a.id}/check`, {
      sessionId: SESSION,
    });
    expect(check.json()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no sandbox is available/),
    });
    // Wired: the routed client is the remote helper, which is no sandbox.
    const helper = { ...sandbox, substrate: null };
    hub.area.useSandbox(
      () => sandbox,
      () => helper,
    );
    const d = (
      await hub.call('POST', `/api/v1/code/sessions/${SESSION}/delegations`, {
        adapterId: a.id,
        prompt: 'think',
      })
    ).json<DelegationView>();
    await hub.area.externalAgents.whenDone(d.id);
    const done = (await hub.call('GET', `/api/v1/delegations/${d.id}`)).json<DelegationView>();
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/without a sandbox \(SSH, WSL or a device\)/);
  });
});
