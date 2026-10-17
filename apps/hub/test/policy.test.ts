// Policy and approvals routes (contracts/hub-api.md; FR-048, FR-099, FR-100, FR-189-FR-191):
// auth, validation, the approval flows over HTTP and the 409 race.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type SettingKey,
  type ToolDescriptor,
} from '@nova/shared';
import type { AuditRecord, GateOutcome, GateRequest, NotificationInput } from '@nova/core';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
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
const purchase: ToolDescriptor = {
  name: 'mcp:shop.purchase_item',
  title: 'purchase_item',
  description: 'Buy an item',
  source: 'mcp',
  serverId: 'shop',
  inputSchema: { type: 'object' },
};

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: PolicyAreaFull;
let events: EventStore;
let settings: Partial<Record<SettingKey, unknown>>;
let audit: AuditRecord[];
let notes: NotificationInput[];
let diagnostics: DiagnosticsRegistry;

async function makeArea(): Promise<PolicyAreaFull> {
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
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
    diagnostics,
    audit: { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n: NotificationInput) => (notes.push(n), Promise.resolve()) },
  } as unknown as Parameters<typeof setupPolicy>[0];
  return setupPolicy(ctx, { home: join(dir, 'home'), approvalTimeoutMs: () => 60_000 });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-policy-'));
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
  events = new EventStore(db);
  settings = {};
  audit = [];
  notes = [];
  diagnostics = new DiagnosticsRegistry();
  area = await makeArea();
  app = Fastify();
  // The Hub's error mapping (app.ts), so status codes match the real server.
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
  await area.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: AUTH,
    ...(payload !== undefined ? { payload: payload as never } : {}),
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

async function asking(r = gateReq()): Promise<{ outcome: Promise<GateOutcome>; id: string }> {
  const outcome = area.gate.check(r, new AbortController().signal);
  let id = '';
  await vi.waitFor(async () => {
    const list = (await call('GET', '/api/v1/approvals')).json().items as {
      id: string;
      callId: string;
    }[];
    const mine = list.find((a) => a.callId === r.callId);
    expect(mine).toBeDefined();
    id = mine!.id;
  });
  return { outcome, id };
}

describe('routes in the real Hub', () => {
  let hub: Hub;
  let hubDir: string;
  let hubDb: NovaDatabase;
  const HOST = { host: '127.0.0.1:7419' };

  beforeEach(async () => {
    hubDir = mkdtempSync(join(tmpdir(), 'nova-hub-policy-real-'));
    const web = join(hubDir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html>');
    hubDb = openDatabase({ path: ':memory:' });
    await migrate(hubDb);
    hub = await buildHub({
      config: loadConfig({ NOVA_DATA_DIR: join(hubDir, 'data'), NOVA_WEB_DIR: web }, []),
      db: hubDb,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    });
  });
  afterEach(async () => {
    await hub.app.close();
    hubDb.close();
    rmSync(hubDir, { recursive: true, force: true });
  });

  it('requires a session for every policy route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/approvals'],
      ['GET', '/api/v1/approvals/x'],
      ['POST', '/api/v1/approvals'],
      ['POST', '/api/v1/approvals/x/handoff-done'],
      ['GET', '/api/v1/policy/rules'],
      ['POST', '/api/v1/policy/rules'],
      ['PATCH', '/api/v1/policy/rules/x'],
      ['DELETE', '/api/v1/policy/rules/x'],
      ['POST', '/api/v1/policy/evaluate'],
      ['GET', '/api/v1/command-rules'],
      ['POST', '/api/v1/command-rules'],
      ['POST', '/api/v1/command-rules/test'],
      ['PATCH', '/api/v1/command-rules/x'],
      ['DELETE', '/api/v1/command-rules/x'],
      ['GET', '/api/v1/permission-grants'],
      ['DELETE', '/api/v1/permission-grants/x'],
      ['GET', '/api/v1/permission-profiles'],
      ['POST', '/api/v1/permission-profiles'],
      ['DELETE', '/api/v1/permission-profiles/x'],
      ['GET', '/api/v1/tool-defaults'],
      ['PUT', '/api/v1/tool-defaults'],
    ] as const) {
      const res = await hub.app.inject({ method, url, headers: HOST, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('serves the policy routes to a signed-in owner', async () => {
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code },
    });
    const cookie = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const headers = { ...HOST, cookie: `${SESSION_COOKIE}=${cookie}` };
    expect((await hub.app.inject({ url: '/api/v1/approvals', headers })).json()).toEqual({
      items: [],
    });
    const profiles = (await hub.app.inject({ url: '/api/v1/permission-profiles', headers })).json();
    expect(profiles.items.map((p: { id: string }) => p.id)).toEqual([
      'read-only',
      'workspace',
      'full',
    ]);
    // The Hub previews with the tools' own descriptors: a built-in write asks; a tool that does not
    // exist is not guessed from its name.
    const preview = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/policy/evaluate',
      headers,
      payload: { tool: 'fs.write', args: { path: 'notes.md', content: 'x' } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ effect: 'ask', tier: 'pre_approvable' });
    const unknown = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/policy/evaluate',
      headers,
      payload: { tool: 'mcp:shop.purchase_item' },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('policy rules and tool defaults', () => {
  it('creates, edits and deletes rules; validates bodies', async () => {
    const created = await call('POST', '/api/v1/policy/rules', {
      scopeKind: 'global',
      match: { tool: 'exec.run' },
      effect: 'ask',
      label: 'Ask before commands',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await call('GET', '/api/v1/policy/rules')).json().items).toHaveLength(1);
    expect(
      (await call('PATCH', `/api/v1/policy/rules/${id}`, { enabled: false })).json(),
    ).toMatchObject({ enabled: false });
    expect((await call('PATCH', `/api/v1/policy/rules/${id}`, {})).statusCode).toBe(400);
    expect((await call('DELETE', `/api/v1/policy/rules/${id}`)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/api/v1/policy/rules/${id}`)).statusCode).toBe(404);
    for (const bad of [
      { scopeKind: 'nowhere', match: {}, effect: 'allow' },
      { scopeKind: 'global', match: { tool: 'x', extra: 1 }, effect: 'allow' },
      { scopeKind: 'global', match: {}, effect: 'act' },
      { scopeKind: 'global', match: { effects: ['captcha'] }, effect: 'deny' },
      { scopeKind: 'tool', match: {}, effect: 'deny' },
      { scopeKind: 'global', match: {}, effect: 'allow', priority: 5000 },
    ])
      expect(
        (await call('POST', '/api/v1/policy/rules', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
  });

  it('keeps managed rules read-only', async () => {
    const m = await area.store.createRule(
      ACCOUNT,
      { scopeKind: 'global', match: {}, effect: 'deny' },
      'managed',
    );
    expect(
      (await call('PATCH', `/api/v1/policy/rules/${m.id}`, { enabled: false })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/api/v1/policy/rules/${m.id}`)).statusCode).toBe(403);
  });

  it('sets and clears per-tool defaults', async () => {
    expect(
      (await call('PUT', '/api/v1/tool-defaults', { tool: 'exec.run', default: 'allow' })).json(),
    ).toEqual({
      tool: 'exec.run',
      default: 'allow',
    });
    expect((await call('GET', '/api/v1/tool-defaults')).json()).toEqual({
      items: [{ tool: 'exec.run', default: 'allow' }],
    });
    expect(
      (await call('PUT', '/api/v1/tool-defaults', { tool: 'exec.run', default: null })).json()
        .default,
    ).toBeNull();
    expect((await call('GET', '/api/v1/tool-defaults')).json()).toEqual({ items: [] });
    expect(
      (await call('PUT', '/api/v1/tool-defaults', { tool: 'exec.run', default: 'maybe' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('POST /policy/evaluate', () => {
  it('previews with no side effects, typed or tool-originated', async () => {
    const typed = await call('POST', '/api/v1/policy/evaluate', {
      tool: 'fs.read',
      args: { path: 'a.md' },
    });
    expect(typed.json()).toMatchObject({ effect: 'ask', source: 'tool_default', ruleId: null });
    area.useToolCatalog((_a, name) =>
      Promise.resolve(name === 'exec.run' ? execTool : name === purchase.name ? purchase : null),
    );
    await call('PUT', '/api/v1/tool-defaults', { tool: 'exec.run', default: 'allow' });
    expect(
      (
        await call('POST', '/api/v1/policy/evaluate', { tool: 'exec.run', args: { cmd: 'ls' } })
      ).json(),
    ).toMatchObject({
      effect: 'allow',
      userDefault: 'allow',
    });
    const fromTool = await call('POST', '/api/v1/policy/evaluate', {
      tool: 'exec.run',
      args: { cmd: 'ls' },
      threadId: THREAD,
      userAsked: false,
    });
    expect(fromTool.json()).toMatchObject({
      effect: 'ask',
      reason: 'the request came from tool content, which cannot authorize actions',
    });
    expect(
      (
        await call('POST', '/api/v1/policy/evaluate', {
          tool: purchase.name,
          args: { url: 'https://shop.example/x' },
        })
      ).json(),
    ).toMatchObject({
      tier: 'confirm_at_action',
    });
    expect((await call('POST', '/api/v1/policy/evaluate', { tool: 'nope.tool' })).statusCode).toBe(
      404,
    );
    expect(
      (await call('POST', '/api/v1/policy/evaluate', { tool: 'exec.run', threadId: 'missing' }))
        .statusCode,
    ).toBe(404);
    expect((await call('POST', '/api/v1/policy/evaluate', { tool: '' })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/approvals?status=all')).json().items).toEqual([]);
    expect(await events.since(null)).toEqual([]);
    expect(audit).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe('command rules', () => {
  const body = {
    pattern: ['git', ['status', 'diff']],
    decision: 'allow',
    matchExamples: ['git status'],
    notMatchExamples: ['git push'],
  };

  it('rejects failing examples with the field and example, on create and edit', async () => {
    const bad = await call('POST', '/api/v1/command-rules', {
      ...body,
      matchExamples: ['git push'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: 'validation',
      message: 'the example "git push" should match the rule but does not',
      details: { field: 'matchExamples', example: 'git push' },
    });
    const created = await call('POST', '/api/v1/command-rules', body);
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const patch = await call('PATCH', `/api/v1/command-rules/${id}`, {
      notMatchExamples: ['git diff HEAD'],
    });
    expect(patch.json().error).toMatchObject({
      details: { field: 'notMatchExamples', example: 'git diff HEAD' },
    });
    expect(
      (await call('PATCH', `/api/v1/command-rules/${id}`, { enabled: false })).json().enabled,
    ).toBe(false);
    expect(
      (await call('POST', '/api/v1/command-rules', { ...body, matchExamples: [] })).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/api/v1/command-rules', { ...body, decision: 'handoff' })).statusCode,
    ).toBe(400);
    expect((await call('GET', '/api/v1/command-rules')).json().items).toHaveLength(1);
    expect((await call('DELETE', `/api/v1/command-rules/${id}`)).json()).toEqual({ ok: true });
  });

  it('tests a command against the rules in scope', async () => {
    const created = (await call('POST', '/api/v1/command-rules', body)).json();
    expect(
      (await call('POST', '/api/v1/command-rules/test', { command: 'git status' })).json(),
    ).toEqual({
      decision: 'allow',
      ruleId: created.id,
      reason: 'allowed by a command rule',
    });
    expect(
      (
        await call('POST', '/api/v1/command-rules/test', {
          command: 'git status && curl x',
          threadId: THREAD,
        })
      ).json(),
    ).toMatchObject({
      decision: null,
    });
    expect(
      (
        await call('POST', '/api/v1/command-rules/test', { command: 'git status', projectId: 'p1' })
      ).json().decision,
    ).toBe('allow');
    expect((await call('POST', '/api/v1/command-rules/test', { command: '' })).statusCode).toBe(
      400,
    );
  });
});

describe('approvals over HTTP (FR-100)', () => {
  it('lists, answers once and refuses a second answer with 409', async () => {
    const { outcome, id } = await asking();
    const view = (await call('GET', `/api/v1/approvals/${id}`)).json();
    expect(view).toMatchObject({
      status: 'pending',
      tier: 'pre_approvable',
      tool: 'exec.run',
      ruleLabel: null,
      alwaysAllowManaged: false,
    });
    const persisted = (await events.since(null)).map((e) => e.name);
    expect(persisted).toEqual(expect.arrayContaining(['policy.tier', 'approval.requested']));
    const requested = (await events.since(null, 500, { threadId: THREAD })).find(
      (e) => e.name === 'approval.requested',
    )!;
    expect(requested.correlation).toMatchObject({ threadId: THREAD, turnId: 'turn-1' });
    const ok = await call('POST', '/api/v1/approvals', { approvalId: id, decision: 'allow_once' });
    expect(ok.json()).toMatchObject({
      status: 'decided',
      decision: 'allow_once',
      decidedBy: 'user',
    });
    const again = await call('POST', '/api/v1/approvals', {
      approvalId: id,
      decision: 'deny_stop',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('conflict');
    expect((await outcome).effect).toBe('allow');
    expect((await call('GET', '/api/v1/approvals')).json().items).toEqual([]);
    expect((await call('GET', '/api/v1/approvals?status=all')).json().items).toHaveLength(1);
    expect(
      (await call('GET', `/api/v1/approvals?status=all&threadId=${THREAD}`)).json().items,
    ).toHaveLength(1);
    expect((await call('GET', '/api/v1/approvals/missing')).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/approvals?status=bogus')).statusCode).toBe(400);
    const decided = (await events.since(null, 500, { threadId: THREAD })).find(
      (e) => e.name === 'approval.decided',
    )!;
    expect(decided.correlation).toMatchObject({ threadId: THREAD, turnId: 'turn-1' });
  });

  it('validates decisions against the card and the schema', async () => {
    const { outcome, id } = await asking();
    expect(
      (await call('POST', '/api/v1/approvals', { approvalId: id, decision: 'timeout' })).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/api/v1/approvals', { approvalId: id, decision: 'allow_always' }))
        .statusCode,
    ).toBe(400);
    expect((await call('POST', '/api/v1/approvals', { approvalId: id })).statusCode).toBe(400);
    const prefix = await call('POST', '/api/v1/approvals', {
      approvalId: id,
      decision: 'allow_always',
      alwaysScope: { kind: 'prefix_rule', rule: { pattern: ['npm', 'ci'] } },
    });
    expect(prefix.statusCode).toBe(400);
    expect(prefix.json().error.details).toMatchObject({
      field: 'matchExamples',
      example: 'npm test',
    });
    const always = await call('POST', '/api/v1/approvals', {
      approvalId: id,
      decision: 'allow_always',
      alwaysScope: { kind: 'prefix_rule', rule: { pattern: ['npm', 'test'] } },
    });
    expect(always.json().decision).toBe('allow_always');
    expect((await outcome).effect).toBe('allow');
    expect((await call('GET', '/api/v1/command-rules')).json().items[0]).toMatchObject({
      pattern: ['npm', 'test'],
    });
    const grants = (await call('GET', '/api/v1/permission-grants')).json().items as {
      id: string;
    }[];
    expect(grants).toHaveLength(1);
    expect((await call('DELETE', `/api/v1/permission-grants/${grants[0]!.id}`)).json()).toEqual({
      ok: true,
    });
    expect((await call('GET', '/api/v1/command-rules')).json().items).toEqual([]);
    expect((await call('DELETE', `/api/v1/permission-grants/${grants[0]!.id}`)).statusCode).toBe(
      404,
    );
  });

  it('confirm_at_action takes no pre-approval; persistent grants off refuses "Always allow" with 403', async () => {
    const buy = await asking(gateReq({ tool: purchase, args: { item: 'x' } }));
    expect(
      (await call('POST', '/api/v1/approvals', { approvalId: buy.id, decision: 'allow_session' }))
        .statusCode,
    ).toBe(400);
    await call('POST', '/api/v1/approvals', {
      approvalId: buy.id,
      decision: 'deny_continue',
      reason: 'too expensive',
    });
    expect(await buy.outcome).toMatchObject({
      effect: 'deny',
      reason: 'too expensive',
      stop: false,
    });
    settings['policy.allowPersistentGrants'] = false;
    const cmd = await asking();
    expect((await call('GET', `/api/v1/approvals/${cmd.id}`)).json().alwaysAllowManaged).toBe(true);
    const res = await call('POST', '/api/v1/approvals', {
      approvalId: cmd.id,
      decision: 'allow_always',
      alwaysScope: { kind: 'tool', tool: 'exec.run' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('policy_denied');
    await call('POST', '/api/v1/approvals', { approvalId: cmd.id, decision: 'deny_stop' });
    expect((await cmd.outcome).effect).toBe('deny');
  });

  it('hands off: the approval stays pending until the step is marked done', async () => {
    const { outcome, id } = await asking();
    expect((await call('POST', `/api/v1/approvals/${id}/handoff-done`, {})).statusCode).toBe(409);
    const handed = await call('POST', '/api/v1/approvals', { approvalId: id, decision: 'handoff' });
    expect(handed.json()).toMatchObject({ status: 'pending', decision: 'handoff' });
    expect(
      (await call('GET', '/api/v1/approvals')).json().items.map((a: { id: string }) => a.id),
    ).toEqual([id]);
    const done = await call('POST', `/api/v1/approvals/${id}/handoff-done`, {
      note: 'paid at the counter',
    });
    expect(done.json()).toMatchObject({ status: 'decided', decision: 'handoff' });
    expect(await outcome).toMatchObject({ effect: 'handoff', note: 'paid at the counter' });
    expect((await call('POST', `/api/v1/approvals/${id}/handoff-done`)).statusCode).toBe(409);
    expect(
      (await call('POST', `/api/v1/approvals/${id}/handoff-done`, { note: 'x'.repeat(3000) }))
        .statusCode,
    ).toBe(400);
  });

  it('grants for the session over HTTP and lists them', async () => {
    const { outcome, id } = await asking();
    await call('POST', '/api/v1/approvals', { approvalId: id, decision: 'allow_session' });
    expect((await outcome).effect).toBe('allow');
    expect((await call('GET', '/api/v1/permission-grants')).json().items).toMatchObject([
      { duration: 'session', tool: 'exec.run', scopeRef: THREAD },
    ]);
  });
});

describe('profiles, recovery and diagnostics', () => {
  it('creates and deletes user profiles', async () => {
    const created = await call('POST', '/api/v1/permission-profiles', {
      name: 'workspace-net',
      extends: 'workspace',
      filesystem: [{ path: ':home', access: 'deny' }],
      network: { mode: 'allowlist', allow: ['registry.npmjs.org'] },
    });
    expect(created.statusCode).toBe(201);
    expect((await call('GET', '/api/v1/permission-profiles')).json().items).toHaveLength(4);
    expect(
      (
        await call('POST', '/api/v1/permission-profiles', {
          name: 'x',
          filesystem: [{ path: 'rel', access: 'read' }],
          network: { mode: 'off' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await call('DELETE', '/api/v1/permission-profiles/workspace')).statusCode).toBe(403);
    expect(
      (await call('DELETE', `/api/v1/permission-profiles/${created.json().id}`)).json(),
    ).toEqual({ ok: true });
  });

  it('cancels approvals left pending by a restart and reports diagnostics', async () => {
    const { outcome, id } = await asking();
    expect(await diagnostics.collect()).toMatchObject({
      policy: { pendingApprovals: 1, waiting: 1, commandRuleErrors: [] },
    });
    const second = await makeArea();
    expect((await call('GET', `/api/v1/approvals/${id}`)).json().status).toBe('cancelled');
    await second.close();
    await area.close();
    expect((await outcome).effect).toBe('deny');
    expect(notes.at(-1)).toMatchObject({
      kind: 'approval',
      href: `/chat/${THREAD}?approval=${id}`,
    });
  });

  it('exposes the wiring hooks for the MCP and tools areas', async () => {
    area.useServerDefaults(() => Promise.resolve('allow'));
    area.useSubstrate(() => 'container');
    const out = await area.gate.check(
      gateReq({
        tool: {
          ...purchase,
          name: 'mcp:shop.list_things',
          title: 'List things',
          description: 'List things',
        },
        args: {},
      }),
      new AbortController().signal,
    );
    expect(out.effect).toBe('allow');
  });
});
