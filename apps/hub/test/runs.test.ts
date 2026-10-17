// Work runs and goals over HTTP (contracts/hub-api.md "Tasks, goals, agents"; FR-051, FR-057,
// FR-181, FR-182, FR-186, FR-187): sessions and validation on every route, a budgeted run that
// pauses and resumes after an extension (J5 step 3), ask-first plans, run controls, the goal
// routes, sub-agents, the activity trace and the approval state from the event bus. A scripted
// turn starter stands in for the chat loop.
/* eslint-disable @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type GoalView,
  type RunView,
  type SettingKey,
} from '@nova/shared';
import {
  DirectRouter,
  ProviderRegistry,
  ThreadService,
  type AuditRecord,
  type StartTurnInput,
  type StartedTurn,
  type TurnAddition,
  type TurnOutcome,
  type TurnStarter,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupRuns, type RunsArea } from '../src/runs.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const AUTH = { 'x-account': ACCOUNT };

interface Script {
  (t: {
    input: StartTurnInput;
    addition: TurnAddition | null;
    step: (activeMs: number, tokens?: number) => boolean;
    call: (name: string, args: unknown) => Promise<unknown>;
    hold: () => Promise<void>;
  }): Promise<{ reply?: string; stop?: TurnOutcome['stop'] }>;
}

/** A scripted chat loop: asks the extension, checks bounds, records usage, calls onEnd. */
class Turns implements TurnStarter {
  script: Script = async () => ({ reply: 'Done.' });
  readonly started: StartTurnInput[] = [];
  readonly running = new Map<string, { abort: AbortController; done: Promise<TurnOutcome> }>();
  readonly holds = new Map<string, () => void>();
  readonly db: () => NovaDatabase;
  readonly area: () => RunsArea;
  constructor(db: () => NovaDatabase, areaOf: () => RunsArea) {
    this.db = db;
    this.area = areaOf;
  }

  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    const db = this.db();
    const turnId = uuidv7();
    const now = new Date().toISOString();
    const n = (
      db.raw.prepare('SELECT COUNT(*) AS n FROM turn WHERE thread_id = ?').get(input.threadId) as {
        n: number;
      }
    ).n;
    db.raw
      .prepare(
        `INSERT INTO turn (id, thread_id, idx, status, trigger, execution_location, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'in_progress', ?, 'hub', ?, ?, ?)`,
      )
      .run(turnId, input.threadId, n + 1, input.trigger, now, now, now);
    db.raw
      .prepare(
        "INSERT INTO message (id, thread_id, turn_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'user', 'complete', ?, ?)",
      )
      .run(uuidv7(), input.threadId, turnId, now, now);
    this.started.push(input);
    const t = db.raw
      .prepare('SELECT mode, project_id AS projectId FROM thread WHERE id = ?')
      .get(input.threadId) as { mode: 'work'; projectId: string | null };
    const addition = await this.area().extension.forTurn({
      accountId: input.accountId,
      threadId: input.threadId,
      turnId,
      mode: t.mode,
      trigger: input.trigger,
      projectId: t.projectId,
    });
    const abort = new AbortController();
    let steps = 0;
    let activeMs = 0;
    let tokens = 0;
    let hit: TurnOutcome['bound'];
    const done = (async (): Promise<TurnOutcome> => {
      await Promise.resolve();
      const res = await this.script({
        input,
        addition,
        step: (ms, tk = 100) => {
          const h = addition?.bounds?.check();
          if (h) {
            hit = h;
            return false;
          }
          steps += 1;
          activeMs += ms;
          tokens += tk;
          addition?.bounds?.record({ inputTokens: tk, outputTokens: 0, costUsd: 0, activeMs: ms });
          return true;
        },
        call: async (name, args) => {
          const tool = (await this.area().tools.list(ACCOUNT)).find(
            (x) => x.descriptor.name === name,
          )!;
          return tool.handler(args, {
            accountId: input.accountId,
            threadId: input.threadId,
            turnId,
            callId: uuidv7(),
            projectId: t.projectId,
            origin: 'model',
            profile: { id: 'workspace', hash: 'x' },
            roots: [],
            sandbox: {} as never,
            signal: abort.signal,
            log: new Logger({ module: 'test', sinks: [] }),
          });
        },
        hold: () =>
          new Promise<void>((resolve) => {
            this.holds.set(input.threadId, resolve);
            abort.signal.addEventListener('abort', () => resolve());
          }),
      });
      let stop: TurnOutcome['stop'] = res.stop ?? 'end';
      if (hit) stop = 'budget';
      if (abort.signal.aborted) stop = 'cancelled';
      const outcome: TurnOutcome = {
        turnId,
        status: stop === 'end' ? 'completed' : 'interrupted',
        stop,
        replyText: res.reply ?? '',
        steps,
        usage: { inputTokens: tokens, outputTokens: 0, costUsd: 0 },
        activeMs,
        ...(hit ? { bound: hit } : {}),
      };
      db.raw
        .prepare("UPDATE turn SET status = ?, stop_reason = ?, ended_at = 'x' WHERE id = ?")
        .run(outcome.status, stop, turnId);
      this.running.delete(input.threadId);
      await addition?.onEnd?.(outcome);
      return outcome;
    })();
    this.running.set(input.threadId, { abort, done });
    return { turnId, messageId: turnId, done };
  }

  async cancel(_a: string, threadId: string): Promise<void> {
    const r = this.running.get(threadId);
    if (!r) return;
    r.abort.abort();
    await r.done;
  }
}

let dir: string;
let db: NovaDatabase;
let app: FastifyInstance;
let area: RunsArea;
let events: EventStore;
let audit: AuditRecord[];
let turns: Turns;
let overrides: Partial<Record<SettingKey, unknown>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-runs-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  events = new EventStore(db);
  audit = [];
  overrides = {};
  const registry = new ProviderRegistry({ db, secrets: new MemorySecretStore() });
  await registry.ensureDefaultProvider(ACCOUNT);
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: {} as never,
    dataDir: join(dir, 'data'),
    registry,
    router,
    nodes: {} as never,
    threads,
    setting: (key: SettingKey) =>
      Promise.resolve((key in overrides ? overrides[key] : SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
    audit: { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: () => Promise.resolve() },
  } as unknown as Parameters<typeof setupRuns>[0];
  area = await setupRuns(ctx);
  turns = new Turns(
    () => db,
    () => area,
  );
  area.useTurns(turns);
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
  for (const r of turns.running.values()) r.abort.abort();
  await settle();
  await area.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: AUTH,
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.allSettled([...turns.running.values()].map((r) => r.done));
    await area.service.idle();
    await new Promise((r) => setImmediate(r));
    if (!turns.running.size) return;
  }
}

async function until(cond: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 3000) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function createRun(body: Record<string, unknown>): Promise<RunView> {
  const res = await call('POST', '/api/v1/runs', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<RunView>();
}

describe('runs routes', () => {
  it('require a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/runs'],
      ['POST', '/api/v1/runs'],
      ['GET', '/api/v1/runs/x'],
      ['POST', '/api/v1/runs/x/pause'],
      ['POST', '/api/v1/runs/x/resume'],
      ['POST', '/api/v1/runs/x/redirect'],
      ['POST', '/api/v1/runs/x/cancel'],
      ['POST', '/api/v1/runs/x/start'],
      ['POST', '/api/v1/runs/x/budget'],
      ['PUT', '/api/v1/runs/x/plan'],
      ['GET', '/api/v1/runs/x/subagents'],
      ['GET', '/api/v1/runs/x/activity'],
      ['GET', '/api/v1/runs/x/goal'],
      ['PUT', '/api/v1/runs/x/goal'],
      ['DELETE', '/api/v1/runs/x/goal'],
      ['GET', '/api/v1/goals'],
      ['GET', '/api/v1/goals/x'],
      ['PATCH', '/api/v1/goals/x'],
      ['POST', '/api/v1/goals/x/pause'],
      ['POST', '/api/v1/goals/x/resume'],
      ['POST', '/api/v1/goals/x/complete'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('validate bodies and answer not_found for unknown runs', async () => {
    expect((await call('POST', '/api/v1/runs', { objective: '' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/api/v1/runs', { objective: 'x', budgets: { timeSeconds: 5 } }))
        .statusCode,
    ).toBe(400);
    expect((await call('POST', '/api/v1/runs', { objective: 'x', extra: 1 })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/runs/nope')).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/runs/nope/budget', {})).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/runs/nope/redirect', {})).statusCode).toBe(400);
    expect((await call('PUT', '/api/v1/runs/nope/plan', { steps: [] })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/goals?status=bogus')).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/runs?status=bogus')).statusCode).toBe(400);
    expect(
      (await call('POST', '/api/v1/runs', { objective: 'x', projectId: 'missing-project' }))
        .statusCode,
    ).toBe(400);
    // An autonomous run needs a reviewer model (FR-085): refused before it starts, not denied
    // action by action.
    const auto = await call('POST', '/api/v1/runs', { objective: 'x', autonomy: 'autonomous' });
    expect(auto.statusCode).toBe(400);
    expect(auto.json().error.details).toMatchObject({ reason: 'review_model_required' });
  });

  it('a budgeted run pauses with a summary and finishes after Extend (J5 step 3)', async () => {
    turns.script = async (t) => {
      if (t.input.text.startsWith('Continue')) {
        t.step(60_000);
        return { reply: 'Summary saved.' };
      }
      await t.call('plan.set', { steps: [{ title: 'Read' }, { title: 'Summarize' }] });
      while (t.step(120_000));
      return { reply: 'Read the first half.' };
    };
    const run = await createRun({
      objective: 'Summarize the attached report',
      budgets: { timeSeconds: 600 },
      goal: { objective: 'A one-page summary exists' },
    });
    expect(run).toMatchObject({ status: 'running', origin: 'user', budgets: { timeSeconds: 600 } });
    expect(turns.started[0]?.authority).toEqual({ kind: 'user', source: `run:${run.id}` });
    await settle();
    const paused = (await call('GET', `/api/v1/runs/${run.id}`)).json<RunView>();
    expect(paused).toMatchObject({
      status: 'paused',
      pauseReason: 'budget_time',
      used: { timeSeconds: 600 },
      derived: { status: 'blocked', reason: 'Budget reached' },
    });
    const goal = (await call('GET', `/api/v1/runs/${run.id}/goal`)).json<GoalView>();
    expect(goal).toMatchObject({ status: 'budget_limited', statusSetBy: 'system' });
    const refused = await call('POST', `/api/v1/runs/${run.id}/resume`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'budget_exhausted' } });
    const ext = await call('POST', `/api/v1/runs/${run.id}/budget`, { timeSeconds: 600 });
    expect(ext.statusCode).toBe(200);
    expect(ext.json<RunView>().budgets.timeSeconds).toBe(1200);
    await settle();
    // The goal resumed with the run; it is still active, so the run stays live.
    const after = (await call('GET', `/api/v1/runs/${run.id}`)).json<RunView>();
    expect(after.status).toBe('running');
    expect(after.used.timeSeconds).toBe(660);
    const done = await call('POST', `/api/v1/goals/${goal.id}/complete`, {});
    expect(done.json<GoalView>().status).toBe('complete');
    const finished = (await call('GET', `/api/v1/runs/${run.id}`)).json<RunView>();
    expect(finished).toMatchObject({ status: 'done', result: { summary: 'Summary saved.' } });
    // The activity trace replays the run (FR-057).
    const items = (await call('GET', `/api/v1/runs/${run.id}/activity`)).json<{
      items: { title: string }[];
    }>().items;
    expect(items.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        'Run created',
        'Plan proposed (2 steps)',
        'Budget reached: time',
        'Budget extended',
        'Run done',
      ]),
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['run.create', 'run.budget.extend', 'goal.set', 'goal.status']),
    );
    expect(audit.find((a) => a.action === 'run.create')).toMatchObject({
      kind: 'run',
      actor: 'user',
      resource: `run:${run.id}`,
    });
    // Persisted run events for the run's thread.
    const persisted = (await events.since(null, 500)).map((x) => x.name);
    expect(persisted).toEqual(
      expect.arrayContaining([
        'run.created',
        'run.budget.reached',
        'run.completed',
        'goal.created',
      ]),
    );
    expect(persisted).not.toContain('run.updated');
  });

  it('ask_first: the plan waits for Start; the user can edit it', async () => {
    overrides['runs.autonomy'] = 'ask_first';
    turns.script = async (t) => {
      if (!t.input.text.startsWith('The plan is approved'))
        await t.call('plan.set', { steps: [{ title: 'Draft' }] });
      return { reply: 'ok' };
    };
    const run = await createRun({ objective: 'Draft the post' });
    expect(run.status).toBe('planning');
    await settle();
    const plan = await call('PUT', `/api/v1/runs/${run.id}/plan`, {
      steps: [{ title: 'Draft' }, { title: 'Proofread', detail: 'twice' }],
    });
    expect(plan.json<RunView>()).toMatchObject({
      planApproved: true,
      plan: [{ title: 'Draft' }, { title: 'Proofread', detail: 'twice' }],
    });
    const started = await call('POST', `/api/v1/runs/${run.id}/start`, {});
    expect(started.json<RunView>().status).toBe('running');
    await settle();
    expect((await call('GET', `/api/v1/runs/${run.id}`)).json<RunView>().status).toBe('done');
    expect((await call('POST', `/api/v1/runs/${run.id}/start`)).statusCode).toBe(409);
  });

  it('pause, resume, redirect and cancel', async () => {
    turns.script = async (t) => {
      await t.hold();
      return { reply: 'r' };
    };
    const run = await createRun({ objective: 'Long job' });
    await until(() => turns.holds.has(run.threadId));
    const p = await call('POST', `/api/v1/runs/${run.id}/pause`);
    expect(p.json<RunView>()).toMatchObject({ status: 'paused', pauseReason: 'user' });
    await settle();
    const r = await call('POST', `/api/v1/runs/${run.id}/resume`, {});
    expect(r.json<RunView>().status).toBe('running');
    await until(() => turns.holds.has(run.threadId) && turns.running.has(run.threadId));
    const red = await call('POST', `/api/v1/runs/${run.id}/redirect`, { text: 'Focus on errors' });
    expect(red.statusCode).toBe(200);
    turns.script = async () => ({ reply: 'ok' });
    turns.holds.get(run.threadId)?.();
    await settle();
    expect(turns.started.at(-1)).toMatchObject({ text: 'Focus on errors', authorKind: 'user' });
    const c = await call('POST', `/api/v1/runs/${run.id}/cancel`);
    expect(c.json<RunView>().status).toBe('done');
    const list = await call('GET', '/api/v1/runs?status=all');
    expect(list.json<{ items: RunView[]; nextCursor: string | null }>()).toMatchObject({
      items: [{ id: run.id }],
      nextCursor: null,
    });
    expect((await call('GET', '/api/v1/runs')).json<{ items: RunView[] }>().items).toEqual([]);
  });

  it('follows approvals and the review breaker from the event bus (docs/09 §9, FR-085)', async () => {
    turns.script = async (t) => {
      await t.hold();
      return { reply: 'ok' };
    };
    const run = await createRun({ objective: 'Needs an approval' });
    await until(() => turns.holds.has(run.threadId));
    const status = async () => (await call('GET', `/api/v1/runs/${run.id}`)).json<RunView>();
    const poll = async (want: string) => {
      for (let i = 0; i < 200; i++) {
        if ((await status()).status === want) return;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error(`never ${want}`);
    };
    const emitStatus = (from: string, to: string) =>
      events.emit({
        name: 'thread.status.changed',
        accountId: ACCOUNT,
        payload: { ref: { kind: 'thread', id: run.threadId }, from, status: to },
      });
    await emitStatus('running', 'needs_input');
    await poll('waiting_approval');
    await emitStatus('needs_input', 'running');
    await poll('running');
    const resets: string[] = [];
    area.useReviewReset((key) => resets.push(key));
    await events.emit({
      name: 'review.breaker.tripped',
      accountId: ACCOUNT,
      correlation: { runId: run.id, threadId: run.threadId },
      payload: {
        runId: run.id,
        threadId: run.threadId,
        consecutiveDenials: 3,
        recentDenials: 3,
        window: 50,
      },
    });
    await poll('paused');
    expect((await status()).pauseReason).toBe('review_breaker');
    await settle();
    turns.script = async () => ({ reply: 'ok' });
    await call('POST', `/api/v1/runs/${run.id}/resume`, {});
    expect(resets).toEqual([run.id, run.threadId]);
    await settle();
    expect((await status()).status).toBe('done');
  });
});

describe('goal routes (FR-181)', () => {
  it('set, read, edit, list, change status and clear', async () => {
    turns.script = async (t) => {
      await t.hold();
      return { reply: 'x' };
    };
    const run = await createRun({ objective: 'Watch the build' });
    expect((await call('GET', `/api/v1/runs/${run.id}/goal`)).json()).toBeNull();
    const set = await call('PUT', `/api/v1/runs/${run.id}/goal`, {
      objective: 'Green build',
      budgets: { tokens: 50_000 },
    });
    expect(set.statusCode).toBe(200);
    const g = set.json<GoalView>();
    expect(g).toMatchObject({ runId: run.id, status: 'active', budgets: { tokens: 50_000 } });
    expect((await call('PUT', `/api/v1/runs/${run.id}/goal`, { objective: '' })).statusCode).toBe(
      400,
    );
    const patched = await call('PATCH', `/api/v1/goals/${g.id}`, { objective: 'Green main' });
    expect(patched.json<GoalView>().objective).toBe('Green main');
    expect((await call('PATCH', `/api/v1/goals/${g.id}`, {})).statusCode).toBe(400);
    expect((await call('GET', `/api/v1/goals/${g.id}`)).json<GoalView>().id).toBe(g.id);
    expect(
      (await call('GET', '/api/v1/goals?status=active')).json<{ items: GoalView[] }>().items,
    ).toHaveLength(1);
    expect((await call('POST', `/api/v1/goals/${g.id}/pause`)).json<GoalView>().status).toBe(
      'paused',
    );
    expect((await call('POST', `/api/v1/goals/${g.id}/resume`)).json<GoalView>().status).toBe(
      'active',
    );
    expect((await call('GET', '/api/v1/goals/nope')).statusCode).toBe(404);
    const del = await call('DELETE', `/api/v1/runs/${run.id}/goal`);
    expect(del.json()).toEqual({ ok: true });
    expect((await call('GET', `/api/v1/runs/${run.id}/goal`)).json()).toBeNull();
    turns.holds.get(run.threadId)?.();
    await settle();
  });
});

describe('sub-agents (FR-053)', () => {
  it('lists a run’s sub-agents', async () => {
    turns.script = async (t) => {
      const isChild = db.raw
        .prepare('SELECT 1 AS x FROM subagent WHERE thread_id = ?')
        .get(t.input.threadId);
      if (isChild) return { reply: 'child result' };
      await t.call('task.spawn', { role: 'researcher', objective: 'Find sources' });
      await t.call('task.wait', { ids: [], timeoutSeconds: 10 });
      return { reply: 'parent' };
    };
    const run = await createRun({ objective: 'Research' });
    await settle();
    const subs = (await call('GET', `/api/v1/runs/${run.id}/subagents`)).json<{
      items: { role: string; status: string; result: string | null; threadId: string }[];
    }>().items;
    expect(subs).toMatchObject([{ role: 'researcher', status: 'done', result: 'child result' }]);
    expect(await area.status.children(ACCOUNT, run.threadId)).toEqual([subs[0]!.threadId]);
  });
});

describe('the Hub wires the runs area', () => {
  it('serves the routes behind a session', async () => {
    const hubDir = mkdtempSync(join(tmpdir(), 'nova-hub-runs-app-'));
    const hubDb = openDatabase({ path: ':memory:' });
    await migrate(hubDb);
    const hub = await buildHub({
      config: loadConfig(
        { NOVA_DATA_DIR: join(hubDir, 'data'), NOVA_WEB_DIR: join(hubDir, 'noweb') },
        [],
      ),
      db: hubDb,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets: new MemorySecretStore(),
    });
    try {
      const host = { host: '127.0.0.1:7419' };
      expect(
        (await hub.app.inject({ method: 'GET', url: '/api/v1/runs', headers: host })).statusCode,
      ).toBe(401);
      const code = await hub.auth.issueSetupCode();
      const setup = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: host,
        payload: { code },
      });
      const token = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      const res = await hub.app.inject({
        method: 'GET',
        url: '/api/v1/runs?status=all',
        headers: { ...host, authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    } finally {
      await hub.app.close();
      hubDb.close();
      rmSync(hubDir, { recursive: true, force: true });
    }
  });
});
