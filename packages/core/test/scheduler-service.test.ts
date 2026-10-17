// The schedule service with a simulated clock (FR-055, FR-187, ADR-079): CRUD and validation,
// fires at the right instants across DST, catch-up once vs skip, restarts without double fires,
// overlap, run-now, the authority a fire carries, outcomes (done, no_news, output_missing,
// failed, cancelled) and delivery receipts.
import { afterEach, describe, expect, it } from 'vitest';
import { isNovaError } from '@nova/shared';
import { NotificationService, ScheduleService, type ScheduleInput } from '../src/index.ts';
import { ACCOUNT, makeHarness, type Harness } from './scheduler-helpers.ts';

let h: Harness;
afterEach(async () => {
  await h.close();
});

const daily = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  when: { cron: '0 9 * * *' },
  timezone: 'UTC',
  instructions: 'Summarize my open pull requests.',
  deliveryTargets: [{ kind: 'inapp' }],
  ...over,
});

async function fieldOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err) && err.code === 'validation')
      return (err.details as { field?: string } | undefined)?.field;
    throw err;
  }
  return undefined;
}

const fires = (id: string) => h.svc.history(ACCOUNT, id);

describe('schedule CRUD', () => {
  it('creates, lists, edits, pauses, resumes and deletes', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily({ notifyCondition: 'only if one is stale' }));
    expect(s).toMatchObject({
      title: 'Summarize my open pull requests.',
      when: { cron: '0 9 * * *' },
      origin: 'user',
      enabled: true,
      nextRunAt: '2026-05-01T09:00:00.000Z',
      catchUp: { policy: 'once', lookbackSeconds: 604800 },
      autonomy: 'standard',
      lastOutcome: null,
    });
    expect((await h.svc.list(ACCOUNT)).map((x) => x.id)).toEqual([s.id]);
    expect((await h.svc.get(ACCOUNT, s.id)).notifyCondition).toBe('only if one is stale');

    const paused = await h.svc.update(ACCOUNT, s.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();
    // Nothing fires while paused; resuming starts from now, not from what was missed.
    await h.clock.advanceTo('2026-05-03T10:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(0);
    const resumed = await h.svc.update(ACCOUNT, s.id, { enabled: true });
    expect(resumed.nextRunAt).toBe('2026-05-04T09:00:00.000Z');

    const edited = await h.svc.update(ACCOUNT, s.id, {
      when: { rrule: 'FREQ=WEEKLY;BYDAY=MO' },
      title: 'Weekly PRs',
    });
    expect(edited.when).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=MO' });
    expect(edited.title).toBe('Weekly PRs');
    // The RRULE's DTSTART is the creation time (08:00 UTC).
    expect(edited.nextRunAt).toBe('2026-05-04T08:00:00.000Z');

    await h.svc.remove(ACCOUNT, s.id);
    expect(await h.svc.list(ACCOUNT)).toEqual([]);
    await expect(h.svc.get(ACCOUNT, s.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.svc.update(ACCOUNT, s.id, { enabled: true })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(h.events.names().filter((n) => n.startsWith('schedule.'))).toEqual([
      'schedule.created',
      'schedule.changed',
      'schedule.changed',
      'schedule.changed',
      'schedule.cancelled',
    ]);
    expect(h.audit.map((a) => [a.kind, a.action])).toEqual([
      ['schedule', 'schedule.create'],
      ['schedule', 'schedule.update'],
      ['schedule', 'schedule.update'],
      ['schedule', 'schedule.update'],
      ['schedule', 'schedule.delete'],
    ]);
  });

  it("names the agent on an agent's schedule events (FR-206)", async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    h.db.raw.exec('PRAGMA foreign_keys = OFF');
    const s = await h.svc.createForAgent(ACCOUNT, daily({ instructions: 'Check the inbox.' }), {
      agentId: 'agent-1',
      origin: 'agent',
      actor: 'agent:agent-1',
    });
    await h.svc.update(ACCOUNT, s.id, { title: 'Inbox' });
    await h.svc.remove(ACCOUNT, s.id);
    const mine = h.events.events.filter((e) =>
      ['schedule.created', 'schedule.changed', 'schedule.cancelled'].includes(e.name),
    );
    expect(mine).toHaveLength(3);
    for (const e of mine) {
      expect(e.correlation).toMatchObject({ agentId: 'agent-1' });
      expect(e.payload).toMatchObject({ scheduleId: s.id, agentId: 'agent-1' });
    }
    // A user's own schedule names no agent.
    await h.svc.create(ACCOUNT, daily());
    expect(h.events.events.at(-1)).toMatchObject({ payload: { agentId: null } });
  });

  it('keeps other accounts out', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    await expect(h.svc.get('someone-else', s.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.svc.list('someone-else')).toEqual([]);
    await expect(h.svc.history('someone-else', s.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('validates every field and names it', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const c = (over: Partial<ScheduleInput>) => fieldOf(h.svc.create(ACCOUNT, daily(over)));
    expect(await c({ when: { cron: '0 25 * * *' } })).toBe('when.cron');
    expect(await c({ when: { rrule: 'FREQ=DAILY;BYSETPOS=1' } })).toBe('when.rrule');
    expect(await c({ when: { at: '2026-04-01T00:00:00Z' } })).toBe('when.at');
    expect(await c({ timezone: 'Nowhere/Land' })).toBe('timezone');
    expect(await c({ startsAt: '2026-06-01T00:00:00Z', endsAt: '2026-05-01T00:00:00Z' })).toBe(
      'endsAt',
    );
    for (const kind of ['slack', 'teams', 'email'] as const)
      expect(await c({ deliveryTargets: [{ kind: 'inapp' }, { kind }] })).toBe(
        'deliveryTargets.1.kind',
      );
    for (const ref of [
      undefined,
      'http://example.com/hook',
      'https://user:pw@example.com/hook',
      'https://10.1.2.3/hook',
      'https://[::1]/hook',
      'https://localhost/hook',
      'https://printer.local/hook',
      'not a url',
    ])
      expect(
        await c({ deliveryTargets: [{ kind: 'webhook', ...(ref ? { ref } : {}) }] }),
        ref,
      ).toBe('deliveryTargets.0.ref');
    expect(await c({ deliveryTargets: [], output: { kind: 'message' } })).toBe('output');
    expect(await c({ output: { kind: 'message', ref: 'webhook' } })).toBe('output.ref');
    expect(await c({ projectId: '01920000-0000-7000-8000-00000000dead' })).toBe('projectId');
    expect(await h.svc.list(ACCOUNT)).toEqual([]);
    await expect(h.svc.update(ACCOUNT, 'x', {})).rejects.toMatchObject({ code: 'not_found' });
    const s = await h.svc.create(ACCOUNT, daily());
    await expect(h.svc.update(ACCOUNT, s.id, {})).rejects.toMatchObject({ code: 'validation' });
    expect(await fieldOf(h.svc.update(ACCOUNT, s.id, { timezone: 'Mars/Base' }))).toBe('timezone');
  });

  it('stores a webhook signing secret only in the secret store and removes it with the schedule', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(
      ACCOUNT,
      daily({ deliveryTargets: [{ kind: 'webhook', ref: 'https://hooks.example.com/nova' }] }),
    );
    const ref = `secret://schedule/${s.id}/webhook`;
    const secret = await h.secrets.get(ref);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(h.db.raw.prepare('SELECT * FROM schedule').all());
    expect(dump).not.toContain(secret);
    expect(JSON.stringify(h.events.events)).not.toContain(secret);
    expect(JSON.stringify(h.audit)).not.toContain(secret);
    await h.svc.remove(ACCOUNT, s.id);
    expect(await h.secrets.has(ref)).toBe(false);
  });
});

describe('firing', () => {
  it('fires at the right instants across a New York DST change', async () => {
    h = await makeHarness('2026-03-07T12:00:00.000Z');
    const s = await h.svc.create(
      ACCOUNT,
      daily({
        when: { cron: '30 2 * * *' },
        timezone: 'America/New_York',
        notifyCondition: 'a PR is older than a week',
      }),
    );
    expect(s.nextRunAt).toBe('2026-03-08T07:00:00.000Z'); // 02:30 does not exist: 03:00 EDT
    await h.clock.advanceTo('2026-03-08T06:59:59Z', h.svc);
    expect(h.runs.created).toHaveLength(0);
    await h.clock.advanceTo('2026-03-08T07:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    const input = h.runs.created[0]!;
    expect(input).toMatchObject({
      accountId: ACCOUNT,
      origin: 'schedule',
      originRef: s.id,
      autonomy: 'standard',
      authority: { kind: 'user', source: `schedule:${s.id}` },
      start: true,
      expectedOutput: null,
      projectId: null,
    });
    expect(input.objective).toContain('Summarize my open pull requests.');
    expect(input.objective).toContain('Notify only if: a PR is older than a week');
    expect(input.objective).toContain('schedule.report');
    const after = await h.svc.get(ACCOUNT, s.id);
    expect(after.lastRunAt).toBe('2026-03-08T07:00:00.000Z');
    expect(after.nextRunAt).toBe('2026-03-09T06:30:00.000Z');
    expect(h.events.events.find((e) => e.name === 'schedule.fired')?.payload).toEqual({
      scheduleId: s.id,
      runId: 'run-1',
      kind: 'fire',
    });
    expect(h.audit.find((a) => a.action === 'schedule.fire')).toMatchObject({
      actor: 'system',
      result: 'run-1',
    });
    h.runs.finish('run-1');
    await h.clock.advanceTo('2026-03-09T06:30:00Z', h.svc);
    expect(h.runs.created).toHaveLength(2);
    expect((await fires(s.id)).map((f) => [f.kind, f.firedAt])).toEqual([
      ['fire', '2026-03-09T06:30:00.000Z'],
      ['fire', '2026-03-08T07:00:00.000Z'],
    ]);
  });

  it('fires a repeated local time once in the Europe/London fold', async () => {
    h = await makeHarness('2026-10-24T12:00:00.000Z');
    const s = await h.svc.create(
      ACCOUNT,
      daily({ when: { cron: '30 1 * * *' }, timezone: 'Europe/London' }),
    );
    await h.clock.advanceTo('2026-10-25T00:30:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    h.runs.finish('run-1');
    await h.clock.advanceTo('2026-10-25T23:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    expect((await h.svc.get(ACCOUNT, s.id)).nextRunAt).toBe('2026-10-26T01:30:00.000Z');
  });

  it('checks again at least every minute and notices a new schedule at once', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    // The first tick runs at once; then the loop sleeps a minute when nothing is due.
    expect(h.clock.timers.map((t) => t.at - h.clock.t)).toEqual([0]);
    await h.clock.advanceTo(h.clock.t, h.svc);
    expect(h.clock.timers.map((t) => t.at - h.clock.t)).toEqual([60_000]);
    await h.svc.create(ACCOUNT, daily({ when: { at: '2026-05-01T08:00:30Z' } }));
    expect(h.clock.timers.map((t) => t.at - h.clock.t)).toEqual([30_000]);
    await h.clock.advanceTo('2026-05-01T08:00:30Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    // A spent one-shot has no next fire.
    expect((await h.svc.list(ACCOUNT))[0]?.nextRunAt).toBeNull();
  });

  it('gives a schedule that a user did not write no authority', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    h.db.raw.prepare("UPDATE schedule SET origin = 'agent' WHERE id = ?").run(s.id);
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    expect(h.runs.created[0]?.authority).toEqual({ kind: 'none', origin: 'system' });
  });

  it('records a skip instead of overlapping a run that is still going', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily({ when: { cron: '0 * * * *' } }));
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    await h.clock.advanceTo('2026-05-01T10:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    const history = await fires(s.id);
    expect(history[0]).toMatchObject({
      kind: 'skipped',
      window: { first: '2026-05-01T10:00:00.000Z', last: '2026-05-01T10:00:00.000Z', count: 1 },
    });
    h.runs.finish('run-1');
    await h.clock.advanceTo('2026-05-01T11:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(2);
  });

  it('runs now outside the rule without moving the next fire', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    const { runId } = await h.svc.runNow(ACCOUNT, s.id);
    expect(runId).toBe('run-1');
    const view = await h.svc.get(ACCOUNT, s.id);
    expect(view.nextRunAt).toBe('2026-05-01T09:00:00.000Z');
    expect(view.lastRunAt).toBe('2026-05-01T08:00:00.000Z');
    expect((await fires(s.id))[0]).toMatchObject({ kind: 'fire', runId: 'run-1', window: null });
    expect(h.audit.some((a) => a.action === 'schedule.run_now' && a.actor === 'user')).toBe(true);
    h.runs.failWith = new Error('no model');
    await expect(h.svc.runNow(ACCOUNT, s.id)).rejects.toMatchObject({ code: 'server_error' });
    await expect(h.svc.runNow(ACCOUNT, 'missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('records a failed fire when the run cannot start', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    h.runs.failWith = new Error('provider down');
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    expect((await fires(s.id))[0]).toMatchObject({ kind: 'fire', outcome: 'failed', runId: null });
    expect((await h.svc.get(ACCOUNT, s.id)).lastOutcome).toBe('failed');
    expect((await h.svc.get(ACCOUNT, s.id)).nextRunAt).toBe('2026-05-02T09:00:00.000Z');
  });

  it('does not fire until the runs area is wired', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    await h.svc.create(ACCOUNT, daily({ when: { cron: '* * * * *' } }));
    // A service with no RunStarter: start() is fine, tick() does nothing.
    const bare = new ScheduleService({ db: h.db, events: h.events, secrets: h.secrets });
    await bare.start();
    h.clock.t = Date.parse('2026-05-01T09:00:00Z');
    await bare.tick();
    expect(h.runs.created).toHaveLength(0);
    await expect(bare.runNow(ACCOUNT, 'x')).rejects.toMatchObject({ code: 'capability_missing' });
    await bare.stop();
  });
});

describe('catch-up (ADR-079)', () => {
  it('collapses fires missed while the Hub was down into one catch-up run', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily({ timezone: 'Europe/London' }));
    await h.svc.stop();
    h.clock.t = Date.parse('2026-05-04T12:00:00Z');
    const svc2 = await h.restart();
    await h.clock.advanceTo(h.clock.t, svc2);
    expect(h.runs.created).toHaveLength(1);
    expect(h.runs.created[0]!.title).toBe('Summarize my open pull requests. (catch-up)');
    expect(h.runs.created[0]!.objective).toContain('3 scheduled runs');
    // Created at 09:00 London on 1 May, so the missed fires are 2, 3 and 4 May.
    expect(h.runs.created[0]!.objective).toContain('from 2 May 2026, 09:00 to 4 May 2026, 09:00');
    const history = await svc2.history(ACCOUNT, s.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'catch_up',
      runId: 'run-1',
      window: { first: '2026-05-02T08:00:00.000Z', last: '2026-05-04T08:00:00.000Z', count: 3 },
    });
    expect(h.events.events.find((e) => e.name === 'schedule.catchup')?.payload).toEqual({
      scheduleId: s.id,
      runId: 'run-1',
      policy: 'once',
      windowFrom: '2026-05-02T08:00:00.000Z',
      windowTo: '2026-05-04T08:00:00.000Z',
      missed: 3,
    });
    expect(h.events.events.find((e) => e.name === 'schedule.fired')?.payload).toMatchObject({
      kind: 'catch_up',
      window: { count: 3 },
    });
    expect((await svc2.get(ACCOUNT, s.id)).nextRunAt).toBe('2026-05-05T08:00:00.000Z');
  });

  it('records the misses without a run when the policy is skip', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily({ catchUp: { policy: 'skip' } }));
    // The machine sleeps through two fires; the loop notices on wake.
    await h.clock.sleepUntil('2026-05-03T10:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(0);
    expect(await fires(s.id)).toEqual([
      expect.objectContaining({
        kind: 'skipped',
        runId: null,
        window: { first: '2026-05-01T09:00:00.000Z', last: '2026-05-03T09:00:00.000Z', count: 3 },
      }),
    ]);
    expect(h.events.events.find((e) => e.name === 'schedule.catchup')?.payload).toMatchObject({
      policy: 'skip',
      reason: 'policy',
      missed: 3,
    });
    expect(h.audit.some((a) => a.action === 'schedule.skip')).toBe(true);
  });

  it('records misses older than the lookback as skipped and catches up the rest', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily({ catchUp: { lookbackSeconds: 2 * 86_400 } }));
    await h.svc.stop();
    h.clock.t = Date.parse('2026-05-06T12:00:00Z');
    const svc2 = await h.restart();
    await h.clock.advanceTo(h.clock.t, svc2);
    const history = await svc2.history(ACCOUNT, s.id);
    expect(history.map((f) => [f.kind, f.window])).toEqual(
      expect.arrayContaining([
        [
          'skipped',
          { first: '2026-05-01T09:00:00.000Z', last: '2026-05-04T09:00:00.000Z', count: 4 },
        ],
        [
          'catch_up',
          { first: '2026-05-05T09:00:00.000Z', last: '2026-05-06T09:00:00.000Z', count: 2 },
        ],
      ]),
    );
    expect(h.runs.created).toHaveLength(1);
  });

  it('still fires on time with a zero lookback, and never catches up with it', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily({ catchUp: { lookbackSeconds: 0 } }));
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    h.runs.finish('run-1');
    await h.clock.sleepUntil('2026-05-03T10:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    expect((await fires(s.id))[0]).toMatchObject({ kind: 'skipped', window: { count: 2 } });
  });
});

describe('restarts', () => {
  it('never fires the same rule time twice and re-attaches to a running run', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(1);
    await h.svc.stop();
    // Same instant, new process: nothing is due again, and the open run is watched.
    const svc2 = await h.restart();
    await h.clock.advanceTo('2026-05-01T09:00:30Z', svc2);
    expect(h.runs.created).toHaveLength(1);
    expect(h.runs.watched.filter((r) => r === 'run-1')).toHaveLength(2);
    h.runs.finish('run-1');
    await svc2.idle();
    expect((await svc2.history(ACCOUNT, s.id))[0]?.outcome).toBe('done');
  });

  it('refuses a second claim of the same rule time even from a stale read', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    // Another process already claimed 09:00 (its row exists) but crashed before moving the rule.
    h.db.raw
      .prepare(
        `INSERT INTO schedule_fire (id, schedule_id, account_id, kind, due_at, run_id, thread_id,
           outcome, fired_at, ended_at)
         VALUES ('f-old', ?, ?, 'fire', '2026-05-01T09:00:00.000Z', 'run-x', 'thread-x', 'done', ?, ?)`,
      )
      .run(s.id, ACCOUNT, '2026-05-01T09:00:00.000Z', '2026-05-01T09:00:01.000Z');
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(0);
    expect((await h.svc.get(ACCOUNT, s.id)).nextRunAt).toBe('2026-05-02T09:00:00.000Z');
  });

  it('stops without waiting forever for a run that does not start', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z', { stopWaitMs: 20 });
    await h.svc.create(ACCOUNT, daily());
    h.runs.createRun = () => new Promise(() => undefined);
    h.clock.t = Date.parse('2026-05-01T09:00:00Z');
    for (const t of h.clock.timers.splice(0)) t.fn();
    const started = Date.now();
    await h.svc.stop();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops firing a rule that no longer compiles instead of spinning', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    h.db.raw.prepare("UPDATE schedule SET timezone = 'Gone/Zone' WHERE id = ?").run(s.id);
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    expect(h.runs.created).toHaveLength(0);
    expect((await h.svc.get(ACCOUNT, s.id)).nextRunAt).toBeNull();
  });

  it('fails a fire the previous process claimed but never started, without firing it again', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await h.svc.create(ACCOUNT, daily());
    await h.svc.stop();
    h.db.raw
      .prepare(
        `INSERT INTO schedule_fire (id, schedule_id, account_id, kind, due_at, fired_at)
         VALUES ('f-crash', ?, ?, 'fire', '2026-05-01T09:00:00.000Z', '2026-05-01T09:00:00.000Z')`,
      )
      .run(s.id, ACCOUNT);
    h.db.raw
      .prepare("UPDATE schedule SET next_run_at = '2026-05-02T09:00:00.000Z' WHERE id = ?")
      .run(s.id);
    h.clock.t = Date.parse('2026-05-01T09:05:00Z');
    const svc2 = await h.restart();
    await h.clock.advanceTo(h.clock.t, svc2);
    expect(h.runs.created).toHaveLength(0);
    expect((await svc2.history(ACCOUNT, s.id))[0]).toMatchObject({ outcome: 'failed' });
  });
});

describe('outcomes and delivery (FR-187)', () => {
  async function fireOnce(over: Partial<ScheduleInput> = {}) {
    const s = await h.svc.create(ACCOUNT, daily(over));
    await h.clock.advanceTo('2026-05-01T09:00:00Z', h.svc);
    return s;
  }

  it('delivers in-app with the notification id as the receipt: done', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await fireOnce({ deliveryTargets: [{ kind: 'inapp' }, { kind: 'os' }] });
    h.runs.finish('run-1', 'done', 'Two PRs need review.');
    await h.svc.idle();
    const { items } = await h.notifications.list(ACCOUNT);
    expect(items).toHaveLength(1); // inapp and os share one notification
    expect(items[0]).toMatchObject({
      kind: 'completion',
      title: 'Summarize my open pull requests.',
      body: 'Two PRs need review.',
      href: '/work/run-1',
    });
    const fire = h.db.raw.prepare('SELECT * FROM schedule_fire').get() as {
      receipts_json: string;
      outcome: string;
    };
    expect(JSON.parse(fire.receipts_json)).toEqual([
      { kind: 'inapp', receipt: items[0]!.id },
      { kind: 'os', receipt: items[0]!.id },
    ]);
    expect(fire.outcome).toBe('done');
    expect((await h.svc.get(ACCOUNT, s.id)).lastOutcome).toBe('done');
    expect(h.events.events.find((e) => e.name === 'schedule.completed')?.payload).toEqual({
      scheduleId: s.id,
      runId: 'run-1',
      outcome: 'done',
    });
  });

  it('delivers the schedule.report message, and nothing at all for no news', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await fireOnce({ when: { cron: '0 * * * *' }, notifyCondition: 'a PR is stale' });
    // The tool is offered while a scheduled run is open and refused on other threads.
    expect((await h.svc.reportTools.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual([
      'schedule.report',
    ]);
    // A turn's listing offers it only in the fired run's thread.
    expect(
      await h.svc.reportTools.list(ACCOUNT, { threadId: 'thread-1', mode: 'work' }),
    ).toHaveLength(1);
    expect(
      await h.svc.reportTools.list(ACCOUNT, { threadId: 'thread-other', mode: 'work' }),
    ).toEqual([]);
    const other = await h.svc.report(ACCOUNT, 'thread-other', { notify: true });
    expect(other).toMatchObject({ ok: false, error: { code: 'not_scheduled' } });
    expect(await h.svc.report(ACCOUNT, 'thread-1', { notify: false })).toMatchObject({ ok: true });
    h.runs.finish('run-1', 'done', 'Nothing is stale.');
    await h.svc.idle();
    expect((await fires(s.id))[0]?.outcome).toBe('no_news');
    expect((await h.notifications.list(ACCOUNT)).items).toHaveLength(0);
    expect(await h.svc.reportTools.list(ACCOUNT)).toEqual([]);

    await h.clock.advanceTo('2026-05-01T10:00:00Z', h.svc);
    const tool = (await h.svc.reportTools.list(ACCOUNT))[0]!;
    const result = await tool.handler({ notify: true, message: 'PR #4 is stale.' }, {
      accountId: ACCOUNT,
      threadId: 'thread-2',
    } as never);
    expect(result.ok).toBe(true);
    h.runs.finish('run-2', 'done', 'A long final reply.');
    await h.svc.idle();
    expect((await fires(s.id))[0]?.outcome).toBe('done');
    expect((await h.notifications.list(ACCOUNT)).items[0]?.body).toBe('PR #4 is stale.');
    expect(await h.svc.report(ACCOUNT, 'thread-2', { notify: true })).toMatchObject({
      ok: false,
    });
  });

  it('ends output_missing when the channel accepts but returns no receipt (J5 step 5)', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const accepted: unknown[] = [];
    const svc = await h.restart({
      // A channel that takes the request and gives nothing back.
      notifier: { notify: (n) => (accepted.push(n), Promise.resolve()) },
    });
    await h.svc.stop();
    const s = await svc.create(ACCOUNT, daily());
    await h.clock.advanceTo('2026-05-01T09:00:00Z', svc);
    h.runs.finish('run-1', 'done', 'Report ready.');
    await svc.idle();
    const [fire] = await svc.history(ACCOUNT, s.id);
    expect(fire).toMatchObject({ outcome: 'output_missing', runId: 'run-1' });
    expect((await svc.get(ACCOUNT, s.id)).lastOutcome).toBe('output_missing');
    // The delivery was attempted, and the user is told it did not arrive, with the run linked.
    expect(accepted).toEqual([
      expect.objectContaining({ kind: 'completion', href: '/work/run-1' }),
      expect.objectContaining({ kind: 'error', href: '/work/run-1' }),
    ]);
    const done = h.events.events.find((e) => e.name === 'schedule.completed');
    expect(done?.payload).toMatchObject({ outcome: 'output_missing', runId: 'run-1' });
    expect(String(done?.payload['detail'])).toContain('no receipt');
  });

  it('ends output_missing when in-app notifications are turned off', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const svc = await h.restart({
      notifier: new NotificationService({
        db: h.db,
        enabled: (k) => Promise.resolve(k !== 'completion'),
      }),
    });
    await h.svc.stop();
    const s = await svc.create(ACCOUNT, daily());
    await h.clock.advanceTo('2026-05-01T09:00:00Z', svc);
    h.runs.finish('run-1');
    await svc.idle();
    expect((await svc.history(ACCOUNT, s.id))[0]?.outcome).toBe('output_missing');
  });

  it('passes failed and cancelled through without delivering', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await fireOnce({ when: { cron: '0 * * * *' } });
    h.runs.finish('run-1', 'failed', 'The model was unavailable.');
    await h.clock.advanceTo('2026-05-01T10:00:00Z', h.svc);
    h.runs.finish('run-2', 'cancelled', null);
    await h.clock.advanceTo('2026-05-01T11:00:00Z', h.svc);
    h.runs.crash('run-3', new Error('runs area lost the run'));
    await h.svc.idle();
    expect((await fires(s.id)).map((f) => f.outcome)).toEqual(['failed', 'cancelled', 'failed']);
    expect((await h.notifications.list(ACCOUNT)).items).toHaveLength(0);
  });

  it('keeps an unverified artifact output missing, and verifies a message output once', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await fireOnce({
      when: { cron: '0 * * * *' },
      output: { kind: 'artifact', ref: 'Daily report' },
    });
    expect(h.runs.created[0]?.expectedOutput).toEqual({ kind: 'artifact', ref: 'Daily report' });
    h.runs.finish('run-1', 'output_missing', 'No report saved.');
    await h.svc.idle();
    expect((await fires(s.id))[0]?.outcome).toBe('output_missing');

    await h.svc.update(ACCOUNT, s.id, { output: { kind: 'message', ref: 'inapp' } });
    await h.clock.advanceTo('2026-05-01T10:00:00Z', h.svc);
    // The runs area verifies the message output before it settles the run.
    const verdict = await h.svc.verifyMessageOutput(ACCOUNT, 'run-2', 'Report ready.');
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toMatch(/^inapp: /);
    // ... and reports output_missing itself because it could not verify a message: the schedule's
    // own check (with the receipt) decides.
    h.runs.finish('run-2', 'output_missing', 'Report ready.');
    await h.svc.idle();
    expect((await fires(s.id))[0]?.outcome).toBe('done');
    // One delivery for run-2, shared by the runs area's check and the schedule's settlement.
    expect(
      (await h.notifications.list(ACCOUNT)).items.filter((n) => n.href === '/work/run-2'),
    ).toHaveLength(1);
    expect(await h.svc.verifyMessageOutput(ACCOUNT, 'run-unknown', null)).toEqual({
      verified: false,
      evidence: 'not a scheduled run',
    });
  });

  it('delivers nothing and needs nothing without targets', async () => {
    h = await makeHarness('2026-05-01T08:00:00.000Z');
    const s = await fireOnce({ deliveryTargets: [] });
    h.runs.finish('run-1');
    await h.svc.idle();
    expect((await fires(s.id))[0]?.outcome).toBe('done');
  });
});
