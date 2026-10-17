// Schedules routes (FR-055, FR-187, ADR-079; contracts/hub-api.md): sessions, create/list/edit/
// pause/delete, validation that names the field, the user-only origin, history and run-now, events
// in the event log, the diagnostics probe, and the J5 step 5 shape through the area (a delivery
// accepted without a receipt ends output_missing with the run linked).
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type ScheduleFireView,
  type ScheduleView,
  type SettingKey,
} from '@nova/shared';
import {
  NotificationService,
  type AuditRecord,
  type AuditSink,
  type CreateRunInput,
  type NotificationInput,
  type RunFinish,
  type RunStarter,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupSchedules, type SchedulesArea, type SchedulesDeps } from '../src/schedules.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000d1';
const AUTH = { 'x-account': ACCOUNT };

class Clock {
  t = Date.parse('2026-05-01T08:00:00.000Z');
  #seq = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];
  now = () => new Date(this.t);
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.#seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  async advanceTo(iso: string, area: SchedulesArea) {
    const end = Date.parse(iso);
    for (;;) {
      await area.service.idle();
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = Math.max(this.t, end);
    await area.service.idle();
  }
}

class Runs implements RunStarter {
  created: CreateRunInput[] = [];
  #done = new Map<string, (f: RunFinish) => void>();
  #waits = new Map<string, Promise<RunFinish>>();
  createRun(input: CreateRunInput) {
    this.created.push(input);
    const n = this.created.length;
    const runId = `run-${n}`;
    this.#waits.set(runId, new Promise((resolve) => this.#done.set(runId, resolve)));
    return Promise.resolve({ runId, threadId: `thread-${n}` });
  }
  whenFinished(_accountId: string, runId: string) {
    return this.#waits.get(runId) ?? new Promise<RunFinish>(() => undefined);
  }
  finish(runId: string, summary = 'Done.') {
    this.#done.get(runId)?.({ runId, status: 'done', summary, artifactIds: [] });
  }
}

let db: NovaDatabase;
let app: FastifyInstance;
let area: SchedulesArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
let clock: Clock;
let runs: Runs;

async function build(deps: Partial<SchedulesDeps> = {}) {
  const auditSink: AuditSink = { append: (r) => (audit.push(r), Promise.resolve()) };
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: new MemorySecretStore(),
    dataDir: '/nonexistent',
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) => Promise.resolve(SETTINGS[key].default as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics,
  } as unknown as Parameters<typeof setupSchedules>[0];
  area = await setupSchedules(ctx, {
    // The ops area's AuditSink is accepted as it is (app.ts passes ops.audit).
    audit: auditSink,
    notifier: new NotificationService({ db, now: clock.now }),
    now: clock.now,
    timers: clock,
    runs,
    ...deps,
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
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  events = new EventStore(db);
  audit = [];
  diagnostics = new DiagnosticsRegistry();
  clock = new Clock();
  runs = new Runs();
  await build();
});

afterEach(async () => {
  await area.close();
  await app.close();
  db.close();
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: AUTH,
    ...(payload !== undefined ? { payload: payload as never } : {}),
  });

const body = {
  when: { cron: '0 9 * * 1-5' },
  timezone: 'Europe/London',
  instructions: 'Check the build and tell me if it is red.',
  notifyCondition: 'only if the build is red',
};

describe('schedules routes', () => {
  it('requires a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/schedules'],
      ['POST', '/api/v1/schedules'],
      ['PATCH', '/api/v1/schedules/x'],
      ['DELETE', '/api/v1/schedules/x'],
      ['GET', '/api/v1/schedules/x/fires'],
      ['POST', '/api/v1/schedules/x/run'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates, lists, pauses without losing targets, edits and deletes', async () => {
    const created = await call('POST', '/api/v1/schedules', {
      ...body,
      deliveryTargets: [
        { kind: 'inapp' },
        { kind: 'webhook', ref: 'https://hooks.example.com/ci' },
      ],
    });
    expect(created.statusCode).toBe(201);
    const s = created.json<ScheduleView>();
    expect(s).toMatchObject({
      title: 'Check the build and tell me if it is red.',
      origin: 'user',
      enabled: true,
      // Created at 09:00 London on a Friday: the next weekday 09:00 is Monday.
      nextRunAt: '2026-05-04T08:00:00.000Z',
    });
    expect(
      (await call('GET', '/api/v1/schedules')).json<{ items: ScheduleView[] }>().items,
    ).toHaveLength(1);

    const paused = await call('PATCH', `/api/v1/schedules/${s.id}`, { enabled: false });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<ScheduleView>()).toMatchObject({
      enabled: false,
      nextRunAt: null,
      deliveryTargets: [
        { kind: 'inapp' },
        { kind: 'webhook', ref: 'https://hooks.example.com/ci' },
      ],
    });
    const edited = await call('PATCH', `/api/v1/schedules/${s.id}`, {
      enabled: true,
      when: { intervalSeconds: 3600 },
      deliveryTargets: [{ kind: 'os' }],
    });
    expect(edited.json<ScheduleView>()).toMatchObject({
      enabled: true,
      when: { intervalSeconds: 3600 },
      deliveryTargets: [{ kind: 'os' }],
      nextRunAt: '2026-05-01T09:00:00.000Z',
    });
    expect((await call('PATCH', `/api/v1/schedules/${s.id}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', '/api/v1/schedules/nope', { enabled: true })).statusCode).toBe(404);

    expect((await call('DELETE', `/api/v1/schedules/${s.id}`)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/api/v1/schedules/${s.id}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/schedules/${s.id}/fires`)).statusCode).toBe(404);

    const names = (await events.since(null, 100)).map((e) => e.name);
    expect(names).toEqual([
      'schedule.created',
      'schedule.changed',
      'schedule.changed',
      'schedule.cancelled',
    ]);
    expect(audit.map((a) => a.action)).toEqual([
      'schedule.create',
      'schedule.update',
      'schedule.update',
      'schedule.delete',
    ]);
  });

  it('refuses agent origins, channels that are not available and bad rules, naming the field', async () => {
    const post = (extra: Record<string, unknown>) =>
      call('POST', '/api/v1/schedules', { ...body, ...extra });
    expect((await post({ origin: 'agent' })).statusCode).toBe(400);
    expect((await post({ origin: 'agent_self', wakeReason: 'x' })).statusCode).toBe(400);
    const slack = await post({ deliveryTargets: [{ kind: 'slack', ref: '#builds' }] });
    expect(slack.statusCode).toBe(400);
    expect(
      slack.json<{ error: { message: string; details: { field: string } } }>().error,
    ).toMatchObject({
      details: { field: 'deliveryTargets.0.kind' },
      message: expect.stringContaining('Slack delivery is not available yet') as unknown,
    });
    const cron = await post({ when: { cron: '0 9 * * MON-FUN' } });
    expect(cron.json<{ error: { details: { field: string } } }>().error.details.field).toBe(
      'when.cron',
    );
    const tz = await post({ timezone: 'GMT+5' });
    expect(tz.json<{ error: { details: { field: string } } }>().error.details.field).toBe(
      'timezone',
    );
    const hook = await post({
      deliveryTargets: [{ kind: 'webhook', ref: 'https://192.168.0.10/x' }],
    });
    expect(hook.json<{ error: { details: { field: string } } }>().error.details.field).toBe(
      'deliveryTargets.0.ref',
    );
    expect((await post({ instructions: '' })).statusCode).toBe(400);
    expect((await post({ when: { intervalSeconds: 30 } })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/schedules')).json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('fires, lists the history and runs now', async () => {
    const s = (
      await call('POST', '/api/v1/schedules', {
        ...body,
        when: { cron: '0 9 * * *' },
        timezone: 'UTC',
      })
    ).json<ScheduleView>();
    await clock.advanceTo('2026-05-01T09:00:00Z', area);
    expect(runs.created).toHaveLength(1);
    expect(runs.created[0]).toMatchObject({ origin: 'schedule', originRef: s.id });
    const now = await call('POST', `/api/v1/schedules/${s.id}/run`, {});
    expect(now.statusCode).toBe(201);
    expect(now.json()).toEqual({ runId: 'run-2' });
    const fires = (await call('GET', `/api/v1/schedules/${s.id}/fires?limit=10`)).json<{
      items: ScheduleFireView[];
    }>().items;
    expect(fires.map((f) => [f.kind, f.runId])).toEqual(
      expect.arrayContaining([
        ['fire', 'run-1'],
        ['fire', 'run-2'],
      ]),
    );
    expect((await call('POST', '/api/v1/schedules/missing/run', {})).statusCode).toBe(404);
    const names = (await events.since(null, 100)).map((e) => e.name);
    expect(names.filter((n) => n === 'schedule.fired')).toHaveLength(2);
    expect(await diagnostics.collect()).toMatchObject({
      schedules: { total: 1, enabled: 1, nextRunAt: '2026-05-02T09:00:00.000Z' },
    });
    expect((await area.reportTools.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual([
      'schedule.report',
    ]);
  });

  it('ends output_missing with the run linked when delivery is accepted without a receipt (J5 step 5)', async () => {
    await area.close();
    await app.close();
    const accepted: NotificationInput[] = [];
    await build({ notifier: { notify: (n) => (accepted.push(n), Promise.resolve()) } });
    const s = (
      await call('POST', '/api/v1/schedules', {
        ...body,
        when: { cron: '0 9 * * *' },
        timezone: 'UTC',
      })
    ).json<ScheduleView>();
    await clock.advanceTo('2026-05-01T09:00:00Z', area);
    runs.finish('run-1', 'The build is red.');
    await area.service.idle();
    const fires = (await call('GET', `/api/v1/schedules/${s.id}/fires`)).json<{
      items: ScheduleFireView[];
    }>().items;
    expect(fires[0]).toMatchObject({ kind: 'fire', runId: 'run-1', outcome: 'output_missing' });
    expect(
      (await call('GET', '/api/v1/schedules')).json<{ items: ScheduleView[] }>().items[0]
        ?.lastOutcome,
    ).toBe('output_missing');
    expect(accepted.map((n) => n.kind)).toEqual(['completion', 'error']);
    const completed = (await events.since(null, 100)).find((e) => e.name === 'schedule.completed');
    expect(completed?.payload).toMatchObject({
      scheduleId: s.id,
      runId: 'run-1',
      outcome: 'output_missing',
    });
    expect(completed?.correlation).toEqual({ runId: 'run-1' });
  });

  it('wires the runs area late and verifies message outputs for it', async () => {
    await area.close();
    await app.close();
    await build({ runs: undefined });
    const s = (
      await call('POST', '/api/v1/schedules', {
        ...body,
        when: { cron: '0 9 * * *' },
        timezone: 'UTC',
      })
    ).json<ScheduleView>();
    expect((await call('POST', `/api/v1/schedules/${s.id}/run`, {})).statusCode).toBe(400);
    area.useRuns(runs);
    await clock.advanceTo('2026-05-01T09:00:00Z', area);
    expect(runs.created).toHaveLength(1);
    const verdict = await area.verifyMessageOutput(ACCOUNT, 'run-1', 'Green.');
    expect(verdict.verified).toBe(true);
    area.useAudit({ append: () => Promise.resolve() });
    area.useNotifier({ notify: () => Promise.resolve() });
    area.useChannel('email', { deliver: () => Promise.resolve({ receipt: 'mail-1' }) });
    const mail = await call('POST', '/api/v1/schedules', {
      ...body,
      deliveryTargets: [{ kind: 'email', ref: 'me@example.com' }],
    });
    expect(mail.statusCode).toBe(201);
  });
});
