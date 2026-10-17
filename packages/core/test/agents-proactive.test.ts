/* eslint-disable @typescript-eslint/require-await */
// Proactive research (FR-082) and agent scheduling (FR-206, FR-059) on a simulated clock: at most
// once an hour while idle and outside quiet hours, read-only, findings as notes and suggestions
// that never count as user intent; self-set wakes with their limits and quiet hours, fired as
// turns on the agent's thread; agent-made schedules.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, eventNames, makeAgentsEnv, type AgentsEnv } from './agents-env.ts';

let h: AgentsEnv;
beforeEach(async () => {
  h = await makeAgentsEnv();
});
afterEach(async () => {
  await h.close();
});

const HOUR = 3_600_000;

describe('proactive research (FR-082)', () => {
  it('runs read-only when idle, at most hourly, and surfaces a finding as a suggestion', async () => {
    const a = await h.agents.create(ACCOUNT, {
      name: 'Scout',
      responsibilities: [{ title: 'Calendar', instructions: 'Spot conflicts' }],
    });
    let offered: string[] = [];
    h.turns.script = async (t) => {
      t.step();
      offered = (
        await h.agents.toolSource.list(ACCOUNT, { threadId: t.input.threadId, mode: 'agent' })
      ).map((x) => x.descriptor.name);
      const write = await t.call('agent.note', { content: 'sneaky' });
      return {
        reply: `Two meetings overlap on Tuesday at 10:00\nThe standup and the design review clash.${write.ok ? ' wrote' : ''}`,
      };
    };
    h.agents.start();
    await h.clock.advance(60_000, () => h.settle());
    const turn = h.turns.started[0]!;
    expect(turn).toMatchObject({
      trigger: 'schedule',
      triggerRef: `proactive:${a.id}`,
      authority: { kind: 'none', origin: 'system' },
      authorKind: 'system',
    });
    expect(turn.threadId).not.toBe(a.primaryThreadId);
    expect(turn.text).toContain('Calendar: Spot conflicts');
    // Read-only: only reading tools are offered, the profile is read-only, and the gate gets a
    // deny for anything that is not.
    expect(offered.sort()).toEqual(
      [
        'agent.background',
        'agent.notes',
        'goal.get',
        'schedule.list',
        'sessions.list',
        'sessions.read',
      ].sort(),
    );
    expect(await h.agents.policy.forThread(ACCOUNT, turn.threadId)).toMatchObject({
      profileId: 'read-only',
      approvalPolicy: 'defaults',
    });
    expect((await h.agents.agentPolicy.forThread(ACCOUNT, turn.threadId))?.rules).toEqual([
      expect.objectContaining({
        effect: 'deny',
        match: { readOnly: false },
        scope: { kind: 'thread', ref: turn.threadId },
      }),
    ]);
    // The finding: an observation note, a suggestion, a notification, events.
    const [s] = await h.agents.listSuggestions(ACCOUNT, a.id);
    expect(s).toMatchObject({
      title: 'Two meetings overlap on Tuesday at 10:00',
      status: 'open',
      threadId: a.primaryThreadId,
    });
    expect(s!.body).not.toContain('wrote');
    const note = (await h.agents.listMemory(ACCOUNT, a.id)).find((m) => m.id === s!.noteId);
    expect(note).toMatchObject({ kind: 'observation', author: 'agent', source: 'proactive' });
    expect(h.notes.at(-1)).toMatchObject({ kind: 'attention', title: 'Scout has a suggestion' });
    expect(eventNames(h.env, 'agent.research.finding')).toHaveLength(1);
    expect(eventNames(h.env, 'agent.suggestion.created')).toHaveLength(1);
    expect((await h.agents.get(ACCOUNT, a.id)).openSuggestions).toBe(1);
    // At most once an hour.
    await h.clock.advance(30 * 60_000, () => h.settle());
    expect(h.turns.started).toHaveLength(1);
    await h.clock.advance(31 * 60_000, () => h.settle());
    expect(h.turns.started).toHaveLength(2);
    // Accepting a suggestion only records it: nothing acts on the agent's words (FR-189).
    const accepted = await h.agents.decideSuggestion(ACCOUNT, a.id, s!.id, 'accept');
    expect(accepted.status).toBe('accepted');
    expect(h.turns.started).toHaveLength(2);
    await expect(h.agents.decideSuggestion(ACCOUNT, a.id, s!.id, 'dismiss')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await h.agents.listSuggestions(ACCOUNT, a.id, 'open')).toHaveLength(1);
  });

  it('skips busy, paused, disabled agents and quiet hours; "Nothing new" leaves no suggestion', async () => {
    const busy = await h.agents.create(ACCOUNT, { name: 'Busy' });
    const off = await h.agents.create(ACCOUNT, { name: 'Off', proactive: false });
    const paused = await h.agents.create(ACCOUNT, { name: 'Paused' });
    await h.agents.pause(ACCOUNT, paused.id);
    h.turns.script = async (t) => {
      t.step();
      if (t.input.trigger === 'user') await t.hold();
      return { reply: 'Nothing new' };
    };
    await h.turns.type(busy.primaryThreadId!, 'a long task');
    await new Promise((r) => setImmediate(r));
    h.quiet.window = {
      start: new Date(h.clock.t).toISOString(),
      end: new Date(h.clock.t + HOUR).toISOString(),
    };
    expect(await h.agents.proactiveTick()).toBe(0);
    h.quiet.window = null;
    expect(await h.agents.proactiveTick()).toBe(0);
    h.turns.release(busy.primaryThreadId!);
    await h.settle();
    expect(await h.agents.proactiveTick()).toBe(1);
    await h.settle();
    expect(await h.agents.listSuggestions(ACCOUNT, busy.id)).toEqual([]);
    expect(h.audit.find((r) => r.action === 'agent.proactive.end')).toMatchObject({
      detail: expect.objectContaining({ result: 'nothing_new' }),
    });
    expect((await h.agents.get(ACCOUNT, off.id)).proactive.lastRunAt).toBeNull();
    expect((await h.agents.get(ACCOUNT, paused.id)).proactive.lastRunAt).toBeNull();
  });

  it('stops a research turn that asks for an approval: it may only read', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    let thread = '';
    h.turns.script = async (t) => {
      t.step();
      thread = t.input.threadId;
      await t.hold();
      return { reply: 'I posted the summary to the team.' };
    };
    expect(await h.agents.researchNow(ACCOUNT, a.id)).toEqual({ started: true, reason: null });
    expect(await h.agents.researchNow(ACCOUNT, a.id)).toEqual({
      started: false,
      reason: 'research is already running',
    });
    // The gate opened an approval for something that is not read-only.
    await h.agents.onApprovalRequested(thread);
    await h.settle();
    expect(h.turns.outcomes.at(-1)?.stop).toBe('cancelled');
    expect(h.audit.find((r) => r.action === 'agent.proactive.denied')).toMatchObject({
      actor: 'system',
    });
    expect(await h.agents.listSuggestions(ACCOUNT, a.id)).toEqual([]);
    // A turn of the main thread is not research: nothing to stop there.
    await h.agents.onApprovalRequested(a.primaryThreadId!);
  });
});

describe('self-set wakes (FR-206) and agent schedules (FR-059)', () => {
  async function callTool(threadId: string, name: string, args: unknown) {
    let out: unknown;
    h.turns.script = async (t) => {
      t.step();
      if (t.input.threadId === threadId && t.input.trigger === 'user')
        out = await t.call(name, args);
      return { reply: 'ok' };
    };
    await (
      await h.turns.type(threadId, `call ${name}`)
    ).done;
    await h.settle();
    return out as {
      ok: boolean;
      error?: { code: string; message: string };
      meta?: Record<string, unknown>;
    };
  }

  it('sets a wake within the limits, lists it as set by the agent and fires it on the agent thread', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const t = a.primaryThreadId!;
    expect(
      (await callTool(t, 'schedule.wake', { in: '2m', reason: 'too soon' })).error?.message,
    ).toMatch(/at least 5 minutes/);
    expect(
      (await callTool(t, 'schedule.wake', { in: '31d', reason: 'too far' })).error?.message,
    ).toMatch(/at most 30 days/);
    expect(
      (await callTool(t, 'schedule.wake', { at: 'not a date', reason: 'x' })).error?.code,
    ).toBe('validation');
    expect((await callTool(t, 'schedule.wake', { reason: 'no time' })).error?.code).toBe(
      'validation',
    );
    const ok = await callTool(t, 'schedule.wake', { in: '1h', reason: 'check the deploy' });
    expect(ok.ok).toBe(true);
    const [w] = await h.scheduler.listForAgent(ACCOUNT, a.id);
    expect(w).toMatchObject({
      origin: 'agent_self',
      agentId: a.id,
      wakeReason: 'check the deploy',
      when: { at: new Date(h.clock.t + HOUR).toISOString() },
      deliveryTargets: [],
    });
    expect(h.env.events.events.find((e) => e.name === 'schedule.wake.set')?.payload).toMatchObject({
      agentId: a.id,
      reason: 'check the deploy',
    });
    expect(h.audit.find((r) => r.action === 'schedule.wake')).toMatchObject({
      actor: `agent:${a.id}`,
    });
    expect(h.audit.find((r) => r.action === 'agent.wake.set')).toBeTruthy();
    // It fires as a turn on the agent's main thread, without the user's authority.
    h.turns.script = async (tt) => {
      tt.step();
      return { reply: 'deploy is fine' };
    };
    h.scheduler.useRuns({
      createRun: () => Promise.reject(new Error('no runs here')),
      whenFinished: () => new Promise(() => undefined),
    });
    await h.scheduler.start();
    await h.clock.advance(HOUR + 1000, () => h.settle());
    const fired = h.turns.started.at(-1)!;
    expect(fired).toMatchObject({
      threadId: t,
      trigger: 'schedule',
      triggerRef: w!.id,
      authorKind: 'schedule',
      authority: { kind: 'none', origin: 'system' },
    });
    expect(fired.text).toContain('You set this wake-up yourself');
    expect((await h.scheduler.history(ACCOUNT, w!.id))[0]).toMatchObject({ outcome: 'done' });
  });

  it('counts every wake a day, cancelled ones too, and moves wakes out of quiet hours', async () => {
    h.settings.wakes = { minMinutes: 5, horizonDays: 30, perDay: 2 };
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const t = a.primaryThreadId!;
    expect((await callTool(t, 'schedule.wake', { in: '10m', reason: 'one' })).ok).toBe(true);
    const [first] = await h.scheduler.listForAgent(ACCOUNT, a.id);
    // The user cancels it from Scheduled; it still counts.
    await h.scheduler.remove(ACCOUNT, first!.id);
    // Quiet hours from 00:30 to 07:00 after now: a wake at 01:00 moves to 07:00.
    const start = h.clock.t + 30 * 60_000;
    h.quiet.window = {
      start: new Date(start).toISOString(),
      end: new Date(start + 6.5 * HOUR).toISOString(),
    };
    const moved = await callTool(t, 'schedule.wake', {
      at: new Date(h.clock.t + HOUR).toISOString(),
      reason: 'two',
    });
    expect(moved.ok).toBe(true);
    expect(moved.meta?.at).toBe(new Date(start + 6.5 * HOUR).toISOString());
    const third = await callTool(t, 'schedule.wake', { in: '20m', reason: 'three' });
    expect(third.error?.message).toMatch(/at most 2 self-set wakes a day/);
    // A day later the count starts again.
    h.quiet.window = null;
    await h.clock.advance(25 * HOUR);
    expect((await callTool(t, 'schedule.wake', { in: '20m', reason: 'four' })).ok).toBe(true);
  });

  it('makes and edits agent schedules, delivering only inside Nova', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const t = a.primaryThreadId!;
    const made = await callTool(t, 'schedule.create', {
      when: { cron: '0 8 * * 1' },
      timezone: 'Europe/Lisbon',
      instructions: 'Weekly report',
    });
    expect(made.ok).toBe(true);
    const [s] = await h.scheduler.listForAgent(ACCOUNT, a.id);
    expect(s).toMatchObject({
      origin: 'agent',
      agentId: a.id,
      deliveryTargets: [{ kind: 'inapp' }],
    });
    const edited = await callTool(t, 'schedule.create', {
      id: s!.id,
      instructions: 'Weekly report, short',
    });
    expect(edited.ok).toBe(true);
    expect((await h.scheduler.listForAgent(ACCOUNT, a.id))[0]?.instructions).toBe(
      'Weekly report, short',
    );
    const webhook = await callTool(t, 'schedule.create', {
      when: { cron: '0 8 * * 1' },
      timezone: 'UTC',
      instructions: 'x',
      deliveryTargets: [{ kind: 'webhook', ref: 'https://hooks.example.com/x' }],
    });
    expect(webhook.error?.code).toBe('policy_denied');
    expect(
      (
        await callTool(t, 'schedule.create', {
          when: { cron: 'nope' },
          timezone: 'UTC',
          instructions: 'x',
        })
      ).ok,
    ).toBe(false);
    expect(
      (await callTool(t, 'schedule.create', { instructions: 'missing when' })).error?.code,
    ).toBe('invalid_arguments');
    // The user's own schedule for the agent: the agent cannot edit or cancel it.
    const mine = await h.agents.createSchedule(ACCOUNT, a.id, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'Mine',
      deliveryTargets: [],
    });
    expect(
      (await callTool(t, 'schedule.create', { id: mine.id, instructions: 'hijack' })).error?.code,
    ).toBe('policy_denied');
    expect((await callTool(t, 'schedule.cancel', { id: mine.id })).error?.code).toBe(
      'policy_denied',
    );
    expect((await callTool(t, 'schedule.cancel', { id: s!.id })).ok).toBe(true);
    const list = await callTool(t, 'schedule.list', {});
    expect(list.ok).toBe(true);
    expect((await h.agents.listSchedules(ACCOUNT, a.id)).map((x) => x.origin)).toEqual(['user']);
  });
});
