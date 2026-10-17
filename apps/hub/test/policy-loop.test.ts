// The policy area in M4 (FR-035, FR-045, FR-197; docs/12 §2.3 step 7): `useHooks`,
// `usePluginPermissions` and `useProjectFolders` reach the gate and POST /policy/evaluate.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnavailableSandbox, noopNotifier } from '@nova/core';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type HookEvent,
  type SettingKey,
  type ToolDescriptor,
} from '@nova/shared';
import type { AuditRecord, GateRequest, PluginPermissions } from '@nova/core';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';
import { setupTools } from '../src/tools.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const AUTH = { 'x-account': ACCOUNT };

const execTool: ToolDescriptor = {
  name: 'exec.run',
  title: 'Run command',
  description: 'Run a command in the sandbox',
  source: 'builtin',
  inputSchema: { type: 'object' },
  annotations: { destructive: true },
  effects: ['exec'],
};
const readTool: ToolDescriptor = {
  name: 'fs.read',
  title: 'Read',
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  annotations: { readOnly: true },
};
const SAMPLE: PluginPermissions = {
  pluginId: 'com.example.sample',
  network: ['api.example.com'],
  fs: [],
  tools: { 'plugin:com.example.sample.fetch_status': { action: 'read', default: 'allow' } },
  actionDefaults: { read: 'allow' },
  hooksAnswerAsks: false,
};

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: PolicyAreaFull;
let ctx: Parameters<typeof setupPolicy>[0];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-policy-loop-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'chat', 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  const settings: Partial<Record<SettingKey, unknown>> = {};
  ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events: new EventStore(db),
    secrets: {} as never,
    dataDir: join(dir, 'data'),
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
    audit: { append: (_r: AuditRecord) => Promise.resolve() },
    notifier: { notify: () => Promise.resolve() },
  };
  area = await setupPolicy(ctx, { home: join(dir, 'home'), approvalTimeoutMs: () => 60_000 });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await area.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function gateReq(over: Partial<GateRequest> = {}): GateRequest {
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: `call-${Math.random()}`,
    projectId: null,
    mode: 'chat',
    tool: execTool,
    args: { cmd: 'npm test' },
    argsPreview: '{"cmd":"npm test"}',
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: '' },
    ...over,
  };
}

describe('the policy area wires M4 into the gate', () => {
  it('useHooks: a user hook answers the ask; the event and the decision are what it saw', async () => {
    const seen: { event: HookEvent; effect: string | undefined }[] = [];
    area.useHooks({
      dispatch: (event, input) => {
        seen.push({ event, effect: input.decision?.effect });
        return Promise.resolve({
          context: [],
          decision: { effect: 'allow', reason: 'tests are safe', hookId: 'hook:user.tests' },
        });
      },
    });
    const out = await area.gate.check(gateReq(), new AbortController().signal);
    expect(out).toMatchObject({ effect: 'allow', reason: 'tests are safe' });
    expect(seen).toEqual([{ event: 'permission.request', effect: 'ask' }]);
  });

  it('usePluginPermissions: POST /policy/evaluate denies a host the plugin did not declare', async () => {
    area.usePluginPermissions({
      forTool: (_a, t) =>
        Promise.resolve(t.name.startsWith('plugin:com.example.sample.') ? SAMPLE : null),
    });
    const evaluate = (url: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/policy/evaluate',
        headers: AUTH,
        payload: { tool: 'plugin:com.example.sample.fetch_status', args: { url }, userAsked: true },
      });
    const denied = await evaluate('https://evil.example.org/');
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({
      effect: 'deny',
      source: 'plugin',
      reason: 'evil.example.org is not a host this plugin declared',
    });
    expect((await evaluate('https://api.example.com/x')).json()).toMatchObject({
      effect: 'allow',
      source: 'plugin',
    });
  });

  it("useProjectFolders: a project's folder is a root the gate accepts", async () => {
    const folder = join(dir, 'proj');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.md'), '# a');
    const r = gateReq({
      projectId: PROJECT,
      tool: readTool,
      args: { path: join(folder, 'a.md') },
      resource: { kind: 'path', value: join(folder, 'a.md') },
    });
    expect((await area.gate.check(r, new AbortController().signal)).effect).toBe('deny');
    area.useProjectFolders((id) =>
      Promise.resolve(id === PROJECT ? [{ path: folder, access: 'read' as const }] : []),
    );
    expect(
      (await area.gate.check({ ...r, callId: 'c2' }, new AbortController().signal)).effect,
    ).toBe('allow');
  });
});

describe("the user's own clicks need no card; an app's own calls ask (FR-189, FR-198)", () => {
  it('POST /tools/fs.write/invoke: initiator user writes at once, an app call waits for approval', async () => {
    const tools = await setupTools({
      ...(ctx as unknown as Parameters<typeof setupTools>[0]),
      gate: area.gate,
      sources: [],
      audit: { append: () => Promise.resolve() },
      notifier: noopNotifier,
      sandbox: new UnavailableSandbox(),
      invokeWaitMs: 300,
    });
    const toolsApp = Fastify();
    toolsApp.setErrorHandler((err, _req, reply) => {
      if (isNovaError(err))
        return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
      return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
    });
    tools.register(toolsApp);
    await toolsApp.ready();
    try {
      const workspace = join(dir, 'data', 'workspace');
      const mine = await toolsApp.inject({
        method: 'POST',
        url: '/api/v1/tools/fs.write/invoke',
        headers: AUTH,
        payload: { args: { path: 'mine.md', content: '# mine' }, initiator: 'user' },
      });
      expect(mine.statusCode).toBe(200);
      expect(mine.json()).toMatchObject({ ok: true });
      expect(readFileSync(join(workspace, 'mine.md'), 'utf8')).toBe('# mine');

      const app = await toolsApp.inject({
        method: 'POST',
        url: '/api/v1/tools/fs.write/invoke',
        headers: AUTH,
        payload: { args: { path: 'app.md', content: '# app' } },
      });
      expect(app.statusCode).toBe(202);
      expect(app.json()).toMatchObject({ approvalId: expect.any(String) });
      expect(existsSync(join(workspace, 'app.md'))).toBe(false);
    } finally {
      await toolsApp.close();
      await tools.close();
    }
  });
});
