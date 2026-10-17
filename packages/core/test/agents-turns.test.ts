/* eslint-disable @typescript-eslint/require-await */
// An agent's turns (docs/09 §8, §2.1, §4; FR-079, FR-083, FR-090, FR-181, FR-072, FR-059): the
// context its turns get (trusted where the user wrote it), budgets per turn chain, goals with
// idle continuation and the blocked rule, pause that cascades to its schedules, wakes and runs,
// stop, safety auto-pause, delegation to background Work runs and the session tools.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, eventNames, makeAgentsEnv, type AgentsEnv } from './agents-env.ts';

let h: AgentsEnv;
beforeEach(async () => {
  h = await makeAgentsEnv();
});
afterEach(async () => {
  await h.close();
});

async function agent(over: Parameters<AgentsEnv['agents']['create']>[1] = { name: 'Scout' }) {
  return h.agents.create(ACCOUNT, over);
}

describe('agent turns', () => {
  it('adds the agent context: user words trusted, its own notes untrusted and out of typed turns', async () => {
    const a = await agent({
      name: 'Scout',
      instructions: 'Be brief.',
      responsibilities: [{ title: 'CI health' }],
    });
    await h.agents.addNote(ACCOUNT, a.id, { content: 'User says: deploys on Fridays are banned' });
    await h.agents.createRule(ACCOUNT, a.id, {
      description: 'Ask before posting',
      effect: 'ask',
      match: { tools: ['channel.*'] },
    });
    h.turns.script = async (t) => {
      t.step();
      await t.call('agent.note', { content: 'Main went red twice this week' });
      return { reply: 'ok' };
    };
    await (
      await h.turns.type(a.primaryThreadId!, 'Check CI')
    ).done;
    await h.settle();
    const typed = h.turns.turns[0]!.addition!.context!;
    const labels = typed.map((b) => [b.label, b.trusted]);
    expect(labels).toEqual([
      ['Agent', true],
      ['Instructions from the user', true],
      ['Responsibilities', true],
      ['Rules (enforced by Nova)', true],
      ['Notes from the user', true],
    ]);
    expect(typed.find((b) => b.label === 'Rules (enforced by Nova)')?.text).toContain(
      'Ask before posting',
    );
    // A turn the agent starts itself (a wake) sees its own notes as data.
    h.turns.script = async (t) => {
      t.step();
      return { reply: 'checked' };
    };
    await h.agents.createSchedule(ACCOUNT, a.id, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'Morning check',
      deliveryTargets: [],
    });
    const [s] = await h.scheduler.listForAgent(ACCOUNT, a.id);
    await h.scheduler.runNow(ACCOUNT, s!.id);
    await h.settle();
    const fired = h.turns.turns.at(-1)!;
    expect(fired.input).toMatchObject({
      trigger: 'schedule',
      triggerRef: s!.id,
      authorKind: 'schedule',
    });
    // The user wrote this schedule: its instructions carry the user's authority (FR-189).
    expect(fired.input.authority).toEqual({ kind: 'user', source: `schedule:${s!.id}` });
    const own = fired.addition!.context!.find((b) => b.label === 'Your notes');
    expect(own).toMatchObject({ trusted: false, origin: 'memory' });
    expect(own?.text).toContain('Main went red twice');
    // The schedule's fire settled when the turn ended (FR-187: no delivery targets).
    const fires = await h.scheduler.history(ACCOUNT, s!.id);
    expect(fires[0]).toMatchObject({ kind: 'fire', outcome: 'done', runId: null });
  });

  it('offers agent tools only in agent threads', async () => {
    const a = await agent();
    const names = (
      await h.agents.toolSource.list(ACCOUNT, { threadId: a.primaryThreadId!, mode: 'agent' })
    ).map((t) => t.descriptor.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'schedule.wake',
        'schedule.create',
        'agent.delegate',
        'sessions.message',
        'goal.set',
      ]),
    );
    expect(
      await h.agents.toolSource.list(ACCOUNT, { threadId: a.primaryThreadId!, mode: 'chat' }),
    ).toEqual([]);
    expect(
      await h.agents.toolSource.list('someone-else', {
        threadId: a.primaryThreadId!,
        mode: 'agent',
      }),
    ).toEqual([]);
    const catalog = (await h.agents.toolSource.list(ACCOUNT)).map((t) => t.descriptor.name);
    expect(catalog).not.toContain('goal.get');
    expect(catalog).toContain('schedule.wake');
    // The internal tools are read-only for the gate; messaging another session is not.
    const msg = (await h.agents.toolSource.list(ACCOUNT)).find(
      (t) => t.descriptor.name === 'sessions.message',
    );
    expect(msg?.descriptor.annotations).toMatchObject({ readOnly: false });
  });

  it('bounds each turn chain by the agent budgets and starts the next one afresh', async () => {
    const a = await agent({ name: 'Scout', budgets: { tokens: 1_000 } });
    h.turns.script = async (t) => {
      while (t.step({ tokens: 600 })) {
        /* keep going until a bound stops it */
      }
      return { reply: 'partial' };
    };
    const first = await (await h.turns.type(a.primaryThreadId!, 'big job')).done;
    await h.settle();
    expect(first).toMatchObject({ stop: 'budget', steps: 2, bound: { bound: 'tokens' } });
    expect(h.notes.at(-1)).toMatchObject({ kind: 'attention', title: 'Scout reached its budget' });
    expect(eventNames(h.env, 'agent.budget.reached')).toHaveLength(1);
    const second = await (await h.turns.type(a.primaryThreadId!, 'again')).done;
    await h.settle();
    expect(second.steps).toBe(2);
    const v = await h.agents.get(ACCOUNT, a.id);
    expect(v.usage.tokens).toBe(2_400);
    expect(v.lastActiveAt).not.toBeNull();
  });

  it('pursues a goal with idle continuation, the blocked rule and its budget (FR-181)', async () => {
    const a = await agent();
    h.turns.script = async (t) => {
      t.step({ tokens: 500 });
      if (t.input.trigger === 'goal')
        await t.call('goal.update', {
          blocker: { key: 'No access', description: 'repo is private' },
        });
      return { reply: 'working' };
    };
    const g = await h.agents.setGoal(ACCOUNT, a.id, {
      objective: 'Fix the flaky test',
      budgets: { tokens: 2_500 },
    });
    expect(g).toMatchObject({ agentId: a.id, status: 'active', threadId: a.primaryThreadId });
    expect((await h.agents.get(ACCOUNT, a.id)).goalId).toBe(g.id);
    for (let i = 0; i < 3; i++) await h.clock.advance(5_000, () => h.settle());
    const goals = h.turns.started.filter((s) => s.trigger === 'goal');
    expect(goals).toHaveLength(3);
    expect(goals[0]).toMatchObject({
      authorKind: 'goal',
      authority: { kind: 'none', origin: 'system' },
      goalId: g.id,
    });
    // The agent may set `blocked` only after the same blocker on 3 consecutive goal turns.
    h.turns.script = async (t) => {
      t.step({ tokens: 10 });
      const r = await t.call('goal.update', { status: 'blocked' });
      return { reply: r.ok ? 'blocked' : 'refused' };
    };
    await h.clock.advance(5_000, () => h.settle());
    let cur = await h.agents.getGoal(ACCOUNT, a.id);
    expect(cur).toMatchObject({ status: 'blocked', statusSetBy: 'agent' });
    expect(h.notes.at(-1)?.title).toBe('Scout: goal blocked');
    expect((await h.agents.get(ACCOUNT, a.id)).derived).toEqual({
      status: 'blocked',
      reason: 'Goal blocked',
    });
    expect(await h.agents.status.blocked(ACCOUNT, [a.primaryThreadId!])).toEqual(
      new Map([[a.primaryThreadId!, 'Goal blocked']]),
    );
    // Its budget: resuming over budget is the runs area's check; here the next goal turn hits it.
    h.env.db.raw
      .prepare("UPDATE goal SET status = 'active', blocker_count = 0 WHERE id = ?")
      .run(g.id);
    await h.agents.onGoalChanged(g.id);
    h.turns.script = async (t) => {
      while (t.step({ tokens: 600 })) {
        /* until a bound */
      }
      return { reply: 'more' };
    };
    await h.clock.advance(5_000, () => h.settle());
    cur = await h.agents.getGoal(ACCOUNT, a.id);
    expect(cur).toMatchObject({ status: 'budget_limited', statusSetBy: 'system' });
    // A cleared goal is gone.
    await h.agents.clearGoal(ACCOUNT, a.id);
    expect(await h.agents.getGoal(ACCOUNT, a.id)).toBeNull();
  });

  it('lets the agent set a goal only when the user asked in this turn', async () => {
    const a = await agent();
    h.turns.script = async (t) => {
      t.step();
      const r = await t.call('goal.set', { objective: 'Ship the release' });
      return { reply: r.ok ? 'set' : `refused: ${r.error.code}` };
    };
    // A wake the agent set itself carries no user instruction.
    await h.agents.createSchedule(ACCOUNT, a.id, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'go',
      deliveryTargets: [],
    });
    h.env.db.raw.prepare("UPDATE schedule SET origin = 'agent'").run();
    const [s] = await h.scheduler.listForAgent(ACCOUNT, a.id);
    await h.scheduler.runNow(ACCOUNT, s!.id);
    await h.settle();
    expect(h.turns.outcomes.at(-1)?.replyText).toBe('refused: policy_denied');
    await (
      await h.turns.type(a.primaryThreadId!, 'Make shipping the release your goal')
    ).done;
    await h.settle();
    expect(h.turns.outcomes.at(-1)?.replyText).toBe('set');
    expect(await h.agents.getGoal(ACCOUNT, a.id)).toMatchObject({
      objective: 'Ship the release',
      status: 'active',
    });
    h.turns.script = async (t) => {
      t.step();
      const get = await t.call('goal.get');
      const done = await t.call('goal.update', {
        status: 'complete',
        progressNote: 'Released 1.2',
      });
      return { reply: `${get.ok ? 'got' : 'no'} ${done.ok ? 'done' : 'refused'}` };
    };
    await (
      await h.turns.type(a.primaryThreadId!, 'how is it going?')
    ).done;
    await h.settle();
    expect(h.turns.outcomes.at(-1)?.replyText).toBe('got done');
    expect(await h.agents.getGoal(ACCOUNT, a.id)).toMatchObject({
      status: 'complete',
      completionSummary: 'Released 1.2',
    });
  });

  it('pause stops the agent with its runs, schedules and wakes; resume brings them back (FR-090)', async () => {
    const a = await agent();
    const thread = a.primaryThreadId!;
    // Background work, a schedule and a wake.
    h.turns.script = async (t) => {
      t.step();
      await t.call('agent.delegate', { objective: 'Collect last week metrics', title: 'Metrics' });
      await t.call('schedule.wake', { in: '2h', reason: 'check the metrics run' });
      return { reply: 'started' };
    };
    await (
      await h.turns.type(thread, 'collect metrics')
    ).done;
    await h.settle();
    await h.agents.createSchedule(ACCOUNT, a.id, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'Morning',
      deliveryTargets: [],
    });
    const runId = h.runs.created.length ? (await h.agents.background(ACCOUNT, a.id))[0]!.runId : '';
    expect(h.runs.created[0]).toMatchObject({
      origin: 'delegation',
      originRef: `agent:${a.id}`,
      agentId: a.id,
      autonomy: 'standard',
      authority: { kind: 'none', origin: 'tool' },
      budgets: { timeSeconds: 1800, tokens: 500_000, costUsd: null },
    });
    // A turn is running when the user pauses.
    h.turns.script = async (t) => {
      t.step();
      await t.hold();
      return { reply: 'held' };
    };
    await h.turns.type(thread, 'long task');
    await new Promise((r) => setImmediate(r));
    const paused = await h.agents.pause(ACCOUNT, a.id);
    await h.settle();
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'user' });
    expect(h.turns.outcomes.at(-1)?.stop).toBe('cancelled');
    expect(h.runs.calls).toEqual([`pause:${runId}`]);
    expect((await h.scheduler.listForAgent(ACCOUNT, a.id)).map((s) => s.enabled)).toEqual([
      false,
      false,
    ]);
    expect(eventNames(h.env, 'agent.paused')).toHaveLength(1);
    // Nothing starts while paused: a schedule's fire fails, research does not start.
    const [sched] = await h.scheduler.listForAgent(ACCOUNT, a.id);
    await expect(h.scheduler.runNow(ACCOUNT, sched!.id)).rejects.toMatchObject({
      code: 'server_error',
    });
    expect(await h.agents.researchNow(ACCOUNT, a.id)).toEqual({
      started: false,
      reason: 'the agent is paused',
    });
    // The wake's time passes during the pause; resuming fires it a minute later.
    await h.clock.advance(3 * 3_600_000, () => h.settle());
    const resumed = await h.agents.resume(ACCOUNT, a.id);
    expect(resumed.status).toBe('active');
    expect(h.runs.calls).toEqual([`pause:${runId}`, `resume:${runId}`]);
    const after = await h.scheduler.listForAgent(ACCOUNT, a.id);
    expect(after.map((s) => s.enabled)).toEqual([true, true]);
    const wake = after.find((s) => s.origin === 'agent_self')!;
    expect(Date.parse(wake.nextRunAt!)).toBe(h.clock.t + 60_000);
    await expect(h.agents.resume(ACCOUNT, a.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(
      h.audit.map((r) => r.action).filter((x) => ['agent.pause', 'agent.resume'].includes(x)),
    ).toEqual(['agent.pause', 'agent.resume']);
  });

  it('the user writing to a paused agent resumes it; a safety pause refuses every turn', async () => {
    const a = await agent();
    const thread = a.primaryThreadId!;
    await h.agents.pause(ACCOUNT, a.id);
    await (
      await h.turns.type(thread, 'hello again')
    ).done;
    await h.settle();
    expect((await h.agents.get(ACCOUNT, a.id)).status).toBe('active');
    expect(h.turns.outcomes.at(-1)?.stop).toBe('end');
    const auto = await h.agents.autoPause(ACCOUNT, a.id, 'repeated denied actions');
    expect(auto).toMatchObject({
      status: 'paused',
      pauseReason: 'safety',
      statusDetail: 'repeated denied actions',
      derived: { status: 'blocked', reason: 'Paused for safety' },
    });
    expect(h.notes.at(-1)).toMatchObject({ title: 'Scout was paused for safety' });
    expect(h.audit.at(-1)).toMatchObject({ action: 'agent.auto_pause', actor: 'system' });
    const refused = await (await h.turns.type(thread, 'please continue')).done;
    expect(refused).toMatchObject({ status: 'failed', error: { code: 'extension_failed' } });
    expect(refused.error?.message).toContain('paused by safety monitoring');
    expect(await h.agents.status.blocked(ACCOUNT, [thread])).toEqual(
      new Map([[thread, 'Paused for safety']]),
    );
    await h.agents.resume(ACCOUNT, a.id);
    expect((await (await h.turns.type(thread, 'go on')).done).stop).toBe('end');
  });

  it('stop cancels the current work and keeps it stopped until the next turn', async () => {
    const a = await agent();
    const thread = a.primaryThreadId!;
    h.turns.script = async (t) => {
      t.step();
      if (t.input.trigger === 'user' && t.input.text === 'work')
        await t.call('agent.delegate', { objective: 'Background crawl' });
      await t.hold();
      return { reply: 'partial result' };
    };
    await h.turns.type(thread, 'work');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const v = await h.agents.stop(ACCOUNT, a.id);
    await h.settle();
    expect(v.status).toBe('stopped');
    expect(h.turns.outcomes.at(-1)).toMatchObject({ stop: 'cancelled' });
    expect(h.runs.calls.filter((c) => c.startsWith('cancel:'))).toHaveLength(1);
    // Stopped: no research and no goal continuation start on their own.
    expect(await h.agents.proactiveTick()).toBe(0);
    h.turns.script = async (t) => {
      t.step();
      return { reply: 'back' };
    };
    await (
      await h.turns.type(thread, 'continue')
    ).done;
    await h.settle();
    expect((await h.agents.get(ACCOUNT, a.id)).status).toBe('active');
    expect(
      h.env.events.events.filter((e) => e.name === 'agent.status.changed').map((e) => e.payload.to),
    ).toEqual(['stopped', 'active']);
  });

  it('fans out background work and gets its result back in the main thread (FR-083, FR-059)', async () => {
    const a = await agent();
    h.turns.script = async (t) => {
      t.step();
      if (t.input.trigger === 'user') {
        const r = await t.call('agent.delegate', {
          objective: 'Summarize the open issues',
          title: 'Issues',
        });
        return { reply: r.ok ? 'delegated' : 'failed' };
      }
      return { reply: 'noted the result' };
    };
    await (
      await h.turns.type(a.primaryThreadId!, 'summarize issues in the background')
    ).done;
    await h.settle();
    const [bg] = await h.agents.background(ACCOUNT, a.id);
    expect(bg).toMatchObject({ title: 'Issues', status: 'running' });
    expect((await h.agents.threadsOf(ACCOUNT, a.id)).map((t) => t.kind)).toEqual([
      'main',
      'background',
    ]);
    expect(await h.agents.status.children(ACCOUNT, a.primaryThreadId!)).toEqual([bg!.threadId]);
    // Background run threads take the runs area's policy, not the agent's thread policy.
    expect(await h.agents.policy.forThread(ACCOUNT, bg!.threadId)).toBeNull();
    // The agent's rules reach its background runs too.
    expect((await h.agents.agentPolicy.forThread(ACCOUNT, bg!.threadId))?.threadKind).toBe(
      'background',
    );
    h.runs.finish(bg!.runId, '12 open issues, 3 critical');
    await h.settle();
    const result = h.turns.started.at(-1)!;
    expect(result).toMatchObject({
      threadId: a.primaryThreadId,
      trigger: 'event',
      triggerRef: bg!.runId,
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
    expect(result.text).toContain('12 open issues, 3 critical');
    const activity = await h.agents.activity(ACCOUNT, a.id);
    expect(activity.length).toBe(0); // the in-memory sink has no event table; the Hub test reads it
  });

  it('lists, reads, messages and archives other sessions as the agent (FR-072)', async () => {
    const a = await agent();
    const other = await h.env.threads.create(ACCOUNT, { mode: 'chat', title: 'Trip planning' });
    h.env.db.raw
      .prepare(
        `INSERT INTO message (id, thread_id, role, author_kind, status, created_at, updated_at)
         VALUES ('m1', ?, 'user', 'user', 'complete', ?, ?)`,
      )
      .run(other.id, new Date().toISOString(), new Date().toISOString());
    h.env.db.raw
      .prepare(
        `INSERT INTO message_part (id, message_id, idx, type, content, created_at)
         VALUES ('p1', 'm1', 0, 'text', 'Flights to Porto on May 3', ?)`,
      )
      .run(new Date().toISOString());
    let results: string[] = [];
    h.turns.script = async (t) => {
      t.step();
      if (t.input.threadId !== a.primaryThreadId) return { reply: 'ack' };
      const list = await t.call('sessions.list', { mode: 'chat' });
      const read = await t.call('sessions.read', { threadId: other.id });
      const msg = await t.call('sessions.message', { threadId: other.id, text: 'Hotel booked.' });
      const own = await t.call('sessions.message', { threadId: a.primaryThreadId, text: 'loop' });
      const arch = await t.call('sessions.archive', { threadId: other.id });
      results = [list, read, msg, own, arch].map((r) =>
        r.ok ? (r.content[0] as { text: string }).text : `error:${r.error.code}`,
      );
      return { reply: 'done' };
    };
    await (
      await h.turns.type(a.primaryThreadId!, 'tidy my sessions')
    ).done;
    await h.settle();
    expect(results[0]).toContain('Trip planning');
    expect(results[1]).toContain('Flights to Porto');
    expect(results[2]).toMatch(/^Message sent/);
    expect(results[3]).toBe('error:validation');
    expect(results[4]).toMatch(/archived/);
    const sent = h.turns.started.find((s) => s.threadId === other.id)!;
    // Never the user's authority in the other session (FR-189).
    expect(sent).toMatchObject({
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
      trigger: 'event',
    });
    expect(sent.text).toContain('Hotel booked.');
    expect(
      (
        h.env.db.raw.prepare('SELECT archived FROM thread WHERE id = ?').get(other.id) as {
          archived: number;
        }
      ).archived,
    ).toBe(1);
    expect(h.audit.map((r) => r.action).filter((x) => x.startsWith('agent.session'))).toEqual([
      'agent.session.message',
      'agent.session.archive',
    ]);
  });
});
