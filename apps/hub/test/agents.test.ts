/* eslint-disable @typescript-eslint/require-await */
// Agents routes (FR-079, FR-082, FR-084, FR-089, FR-090, FR-181, FR-194, FR-206; contracts/
// hub-api.md "Tasks, goals, agents"): sessions, CRUD with an avatar, responsibilities, rules
// with preview, memory, goal, user schedules for an agent, pause/resume/stop, proactive research
// and suggestions, activity from the event log, external agents, delete with its confirmation,
// the diagnostics probe, and the late wiring the lead adds to app.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_DELETE_NOTICE,
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type AgentView,
  type SettingKey,
} from '@nova/shared';
import {
  ScheduleService,
  ThreadService,
  type AuditRecord,
  type ModelRouter,
  type NotificationInput,
  type StartTurnInput,
  type StartedTurn,
  type TurnOutcome,
  type TurnStarter,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { setupAgents, type AgentsArea } from '../src/agents.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000e1';
const AUTH = { 'x-account': ACCOUNT };
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Ends every turn at once with a reply, asking the agent extension like the chat loop does. */
class Turns implements TurnStarter {
  readonly started: StartTurnInput[] = [];
  reply = 'Two invoices are due this week\nPay them before Friday.';
  area: AgentsArea | null = null;
  db: NovaDatabase | null = null;

  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    this.started.push(input);
    const turnId = uuidv7();
    const now = new Date().toISOString();
    this.db!.raw.prepare(
      `INSERT INTO turn (id, thread_id, idx, status, trigger, execution_location, started_at,
           created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, 'hub', ?, ?, ?)`,
    ).run(turnId, input.threadId, this.started.length, input.trigger, now, now, now);
    const addition = await this.area!.extension.forTurn({
      accountId: input.accountId,
      threadId: input.threadId,
      turnId,
      mode: 'agent',
      trigger: input.trigger,
      projectId: null,
    });
    const outcome: TurnOutcome = {
      turnId,
      status: 'completed',
      stop: 'end',
      replyText: this.reply,
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      activeMs: 10,
    };
    const done = (async () => {
      await Promise.resolve();
      this.db!.raw.prepare("UPDATE turn SET status = 'completed', ended_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        turnId,
      );
      await addition?.onEnd?.(outcome);
      return outcome;
    })();
    return { turnId, messageId: uuidv7(), done };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: AgentsArea;
let events: EventStore;
let audit: AuditRecord[];
let notes: NotificationInput[];
let diagnostics: DiagnosticsRegistry;
let scheduler: ScheduleService;
let turns: Turns;
let settings: Partial<Record<SettingKey, unknown>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-agents-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  events = new EventStore(db);
  audit = [];
  notes = [];
  settings = {};
  diagnostics = new DiagnosticsRegistry();
  const router = {
    firstModel: () => Promise.resolve(null),
    usable: () => Promise.resolve(true),
  } as unknown as ModelRouter;
  const threads = new ThreadService({ db, router, events });
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
    dataDir: join(dir, 'data'),
    registry: {} as never,
    router,
    nodes: {} as never,
    threads,
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics,
    audit: { append: async (r: AuditRecord) => void audit.push(r) },
    notifier: { notify: async (n: NotificationInput) => void notes.push(n) },
  };
  area = await setupAgents(ctx);
  scheduler = new ScheduleService({
    db,
    events,
    secrets: ctx.secrets,
    audit: { append: async (r) => void audit.push(r as AuditRecord) },
  });
  turns = new Turns();
  turns.area = area;
  turns.db = db;
  // The wiring app.ts adds (see the area's header).
  area.useTurns(turns);
  area.useScheduler(scheduler);
  scheduler.useAgents(area.scheduleTarget);
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
  await scheduler.stop();
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

async function create(body: Record<string, unknown> = { name: 'Scout' }): Promise<AgentView> {
  const res = await call('POST', '/api/v1/agents', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<AgentView>();
}

describe('agents routes', () => {
  it('requires a session everywhere', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/agents'],
      ['POST', '/api/v1/agents'],
      ['GET', '/api/v1/agents/x'],
      ['PATCH', '/api/v1/agents/x'],
      ['DELETE', '/api/v1/agents/x'],
      ['GET', '/api/v1/agents/x/avatar'],
      ['POST', '/api/v1/agents/x/pause'],
      ['POST', '/api/v1/agents/x/research'],
      ['GET', '/api/v1/agents/x/rules'],
      ['POST', '/api/v1/agents/x/rules'],
      ['GET', '/api/v1/agents/x/memory'],
      ['GET', '/api/v1/agents/x/goal'],
      ['GET', '/api/v1/agents/x/activity'],
      ['GET', '/api/v1/agents/x/suggestions'],
      ['POST', '/api/v1/agents/x/schedules'],
      ['GET', '/api/v1/external-agents'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates, lists, reads, edits an agent with its avatar; validates the body', async () => {
    const bad = await call('POST', '/api/v1/agents', { name: '' });
    expect(bad.statusCode).toBe(400);
    expect((await call('POST', '/api/v1/agents', { name: 'x', extra: 1 })).statusCode).toBe(400);
    const a = await create({
      name: 'Scout',
      instructions: 'Watch the build',
      avatar: { mime: 'image/png', data: PNG },
      responsibilities: [{ title: 'CI' }],
    });
    expect(a).toMatchObject({ name: 'Scout', hasAvatar: true, status: 'active' });
    const avatar = await call('GET', `/api/v1/agents/${a.id}/avatar`);
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers['content-type']).toBe('image/png');
    expect((await call('GET', '/api/v1/agents')).json<{ items: AgentView[] }>().items).toHaveLength(
      1,
    );
    const patched = await call('PATCH', `/api/v1/agents/${a.id}`, { name: 'Ranger', avatar: null });
    expect(patched.json()).toMatchObject({ name: 'Ranger', hasAvatar: false });
    expect((await call('GET', `/api/v1/agents/${a.id}/avatar`)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/v1/agents/${a.id}`, {})).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/agents/nope')).statusCode).toBe(404);
    // An autonomous agent needs a reviewer model.
    const auto = await call('POST', '/api/v1/agents', { name: 'A', autonomy: 'autonomous' });
    expect(auto.statusCode).toBe(400);
    expect(auto.json()).toMatchObject({ error: { details: { reason: 'review_model_required' } } });
    expect((await call('GET', `/api/v1/agents/${a.id}/threads`)).json()).toMatchObject({
      items: [{ kind: 'main', threadId: a.primaryThreadId }],
    });
    // The event log has the agent's events, and its activity reads them.
    const names = (await events.since(null, 100)).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['agent.created', 'agent.updated']));
    const activity = (await call('GET', `/api/v1/agents/${a.id}/activity`)).json<{
      items: { title: string }[];
    }>();
    expect(activity.items.map((i) => i.title)).toContain('Agent created');
  });

  it('manages responsibilities, rules with preview, and memory', async () => {
    const a = await create();
    const r = await call('POST', `/api/v1/agents/${a.id}/responsibilities`, { title: 'Inbox' });
    expect(r.statusCode).toBe(201);
    const rid = r.json<{ id: string }>().id;
    expect(
      (
        await call('PATCH', `/api/v1/agents/${a.id}/responsibilities/${rid}`, { status: 'done' })
      ).json(),
    ).toMatchObject({ status: 'done' });
    expect((await call('GET', `/api/v1/agents/${a.id}/responsibilities`)).json()).toMatchObject({
      items: [{ id: rid }],
    });
    expect((await call('DELETE', `/api/v1/agents/${a.id}/responsibilities/${rid}`)).json()).toEqual(
      { ok: true },
    );

    const rule = await call('POST', `/api/v1/agents/${a.id}/rules`, {
      description: 'Ask before posting',
      effect: 'ask',
      match: { tools: ['channel.*'], channels: [{ kind: 'slack', conversation: '#general' }] },
    });
    expect(rule.statusCode).toBe(201);
    const ruleId = rule.json<{ id: string }>().id;
    const badRule = await call('POST', `/api/v1/agents/${a.id}/rules`, {
      description: 'x',
      effect: 'handoff',
      command: { pattern: ['ls'], matchExamples: ['ls'], notMatchExamples: ['rm'] },
    });
    expect(badRule.statusCode).toBe(400);
    expect(
      (await call('POST', `/api/v1/agents/${a.id}/rules`, { description: 'x', effect: 'deny' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/api/v1/agents/${a.id}/rules/${ruleId}`, { effect: 'act_on_request' })
      ).json(),
    ).toMatchObject({ effect: 'act_on_request' });
    expect((await call('GET', `/api/v1/agents/${a.id}/rules/${ruleId}/preview`)).json()).toEqual({
      items: [],
    });
    expect((await call('GET', `/api/v1/agents/${a.id}/rules`)).json()).toMatchObject({
      items: [{ id: ruleId }],
    });
    expect((await call('DELETE', `/api/v1/agents/${a.id}/rules/${ruleId}`)).json()).toEqual({
      ok: true,
    });
    expect(audit.map((x) => x.action)).toEqual(
      expect.arrayContaining(['agent.rule.create', 'agent.rule.update', 'agent.rule.delete']),
    );

    const note = await call('POST', `/api/v1/agents/${a.id}/memory`, {
      content: 'Prefers mornings',
    });
    expect(note.statusCode).toBe(201);
    const noteId = note.json<{ id: string }>().id;
    expect(
      (await call('PATCH', `/api/v1/agents/${a.id}/memory/${noteId}`, { pinned: true })).json(),
    ).toMatchObject({
      pinned: true,
    });
    expect((await call('GET', `/api/v1/agents/${a.id}/memory`)).json()).toMatchObject({
      items: [{ id: noteId, store: 'notes', author: 'user' }],
    });
    expect((await call('DELETE', `/api/v1/agents/${a.id}/memory/${noteId}`)).json()).toEqual({
      ok: true,
    });
    expect((await call('DELETE', `/api/v1/agents/${a.id}/memory/${noteId}`)).statusCode).toBe(404);
  });

  it('sets, reads and clears the agent goal (FR-181)', async () => {
    const a = await create();
    const none = await call('GET', `/api/v1/agents/${a.id}/goal`);
    expect(none.body).toBe('null');
    const put = await call('PUT', `/api/v1/agents/${a.id}/goal`, {
      objective: 'Keep the inbox at zero',
      budgets: { tokens: 50_000 },
    });
    expect(put.json()).toMatchObject({
      agentId: a.id,
      status: 'active',
      budgets: { tokens: 50_000 },
    });
    expect((await call('GET', `/api/v1/agents/${a.id}/goal`)).json()).toMatchObject({
      objective: 'Keep the inbox at zero',
    });
    expect((await call('PUT', `/api/v1/agents/${a.id}/goal`, { objective: '' })).statusCode).toBe(
      400,
    );
    expect((await call('DELETE', `/api/v1/agents/${a.id}/goal`)).json()).toEqual({ ok: true });
    expect((await call('GET', `/api/v1/agents/${a.id}/goal`)).body).toBe('null');
  });

  it('schedules the agent as the user, and lists it under the agent (FR-059)', async () => {
    const a = await create();
    const res = await call('POST', `/api/v1/agents/${a.id}/schedules`, {
      when: { cron: '0 9 * * 1-5' },
      timezone: 'UTC',
      instructions: 'Morning briefing',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ origin: 'user', agentId: a.id });
    expect((await call('GET', `/api/v1/agents/${a.id}/schedules`)).json()).toMatchObject({
      items: [{ origin: 'user', agentId: a.id }],
    });
    expect(
      (await call('POST', `/api/v1/agents/${a.id}/schedules`, { instructions: 'x' })).statusCode,
    ).toBe(400);
    // Run now: a turn on the agent's main thread with the user's authority.
    const sched = res.json<{ id: string }>();
    const now = await scheduler.runNow(ACCOUNT, sched.id);
    expect(now).toEqual({ runId: null, threadId: a.primaryThreadId });
    expect(turns.started.at(-1)).toMatchObject({
      threadId: a.primaryThreadId,
      trigger: 'schedule',
      authority: { kind: 'user', source: `schedule:${sched.id}` },
    });
  });

  it('pauses, resumes and stops; researches now and decides the suggestion', async () => {
    const a = await create();
    expect((await call('POST', `/api/v1/agents/${a.id}/pause`, {})).json()).toMatchObject({
      status: 'paused',
    });
    expect((await call('POST', `/api/v1/agents/${a.id}/research`, {})).json()).toEqual({
      started: false,
      reason: 'the agent is paused',
    });
    expect((await call('POST', `/api/v1/agents/${a.id}/resume`, {})).json()).toMatchObject({
      status: 'active',
    });
    expect((await call('POST', `/api/v1/agents/${a.id}/resume`, {})).statusCode).toBe(409);
    const research = await call('POST', `/api/v1/agents/${a.id}/research`, {});
    expect(research.statusCode).toBe(202);
    await new Promise((r) => setImmediate(r));
    await area.service.idle();
    const sug = (await call('GET', `/api/v1/agents/${a.id}/suggestions?status=open`)).json<{
      items: { id: string; title: string }[];
    }>();
    expect(sug.items[0]?.title).toBe('Two invoices are due this week');
    expect(notes.at(-1)).toMatchObject({ title: 'Scout has a suggestion' });
    const dismissed = await call(
      'POST',
      `/api/v1/agents/${a.id}/suggestions/${sug.items[0]!.id}/dismiss`,
      {},
    );
    expect(dismissed.json()).toMatchObject({ status: 'dismissed' });
    expect((await call('GET', `/api/v1/agents/${a.id}/suggestions?status=bogus`)).statusCode).toBe(
      400,
    );
    expect((await call('POST', `/api/v1/agents/${a.id}/stop`, {})).json()).toMatchObject({
      status: 'stopped',
    });
    expect((await call('GET', `/api/v1/agents/${a.id}/background`)).json()).toEqual({ items: [] });
  });

  it('marks external agents', async () => {
    const res = await call('POST', '/api/v1/external-agents', {
      address: 'Billing Agent',
      label: 'vendor bot',
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ id: string }>().id;
    expect((await call('GET', '/api/v1/external-agents')).json()).toMatchObject({
      items: [{ id, address: 'billing agent' }],
    });
    expect((await call('POST', '/api/v1/external-agents', {})).statusCode).toBe(400);
    expect((await call('DELETE', `/api/v1/external-agents/${id}`)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/api/v1/external-agents/${id}`)).statusCode).toBe(404);
  });

  it('deletes only with the confirmation, which says what is not undone (FR-090)', async () => {
    const a = await create();
    const missing = await call('DELETE', `/api/v1/agents/${a.id}`);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: { message: AGENT_DELETE_NOTICE, details: { reason: 'confirmation_required' } },
    });
    expect((await call('DELETE', `/api/v1/agents/${a.id}`, { confirm: true })).json()).toEqual({
      ok: true,
    });
    expect((await call('GET', `/api/v1/agents/${a.id}`)).statusCode).toBe(404);
    expect(audit.find((r) => r.action === 'agent.delete')).toMatchObject({
      kind: 'agent',
      actor: 'user',
    });
  });

  it('reports counts to diagnostics', async () => {
    const a = await create();
    await create({ name: 'Two' });
    await call('POST', `/api/v1/agents/${a.id}/pause`, {});
    expect((await diagnostics.collect()).agents).toEqual({ total: 2, active: 1, paused: 1 });
  });

  it('stops a research turn that asks for an approval (the area follows approval.requested)', async () => {
    const a = await create();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // A research turn that waits: the gate asks for an approval meanwhile.
    turns.startTurn = async (input) => {
      turns.started.push(input);
      const turnId = uuidv7();
      const addition = await area.extension.forTurn({
        accountId: input.accountId,
        threadId: input.threadId,
        turnId,
        mode: 'agent',
        trigger: input.trigger,
        projectId: null,
      });
      const done = (async () => {
        await held;
        const outcome: TurnOutcome = {
          turnId,
          status: 'interrupted',
          stop: 'cancelled',
          replyText: '',
          steps: 1,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          activeMs: 1,
        };
        await addition?.onEnd?.(outcome);
        return outcome;
      })();
      return { turnId, messageId: uuidv7(), done };
    };
    turns.cancel = () => {
      release();
      return Promise.resolve();
    };
    await call('POST', `/api/v1/agents/${a.id}/research`, {});
    const research = turns.started.at(-1)!;
    await events.emit({
      name: 'approval.requested',
      accountId: ACCOUNT,
      correlation: { threadId: research.threadId },
      payload: { approvalId: 'x' },
    });
    await held;
    await area.service.idle();
    expect(audit.find((r) => r.action === 'agent.proactive.denied')).toBeTruthy();
  });
});
