// Goals (FR-181, docs/09 §2.1, contracts/schemas/goal.json): idle continuation after a debounce,
// the blocked rule enforced by the runtime, who may set which status, goal.set only when the user
// asked, and the user's controls.
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAgentStatus,
  goalUserTransition,
  nextBlockerCount,
  normalizeBlockerKey,
} from '../src/index.ts';
import { ACCOUNT, makeRunsEnv, type FakeTurn, type RunsEnv } from './runs-env.ts';

let e: RunsEnv;

beforeEach(async () => {
  e = await makeRunsEnv();
});

afterEach(async () => {
  await e.close();
});

const text = (r: { ok: boolean; content?: { type: string; text?: string }[] }) =>
  r.ok ? (r.content?.[0]?.text ?? '') : '';

async function goalRun(script: (t: FakeTurn) => Promise<{ reply?: string } | undefined>) {
  e.turns.script = script;
  const v = await e.runs.create({
    accountId: ACCOUNT,
    objective: 'Keep the release notes current',
    origin: 'user',
    authority: { kind: 'user', source: 'test' },
    start: true,
    goal: { objective: 'Release notes match the merged changes' },
  });
  await e.settle();
  return v;
}

describe('idle continuation', () => {
  it('starts a goal turn after the debounce while the goal is active and the thread idle', async () => {
    const v = await goalRun(async (t) => {
      t.step();
      return { reply: 'Updated two entries.' };
    });
    // The turn ended but the goal is active: the run stays live and waits for the debounce.
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('running');
    const goal = (await e.runs.getRunGoal(ACCOUNT, v.id))!;
    expect(goal).toMatchObject({ status: 'active', statusSetBy: 'user', runId: v.id });
    expect(e.env.events.names()).toContain('goal.created');
    const before = e.turns.started.length;
    await e.clock.advance(4_000, () => e.settle());
    expect(e.turns.started.length).toBe(before);
    let blocks: string[] = [];
    e.turns.script = async (t) => {
      blocks = (t.addition?.context ?? []).map((b) => `${b.label}:${b.trusted}`);
      await t.call('goal.update', { status: 'complete', progressNote: 'All entries match.' });
      return { reply: 'Complete.' };
    };
    await e.clock.advance(1_000, () => e.settle());
    const cont = e.turns.started.at(-1)!;
    expect(cont).toMatchObject({
      trigger: 'goal',
      triggerRef: goal.id,
      goalId: goal.id,
      authorKind: 'goal',
      // A continuation authorizes nothing (FR-189).
      authority: { kind: 'none', origin: 'system' },
    });
    expect(cont.text).toMatch(/Remaining budget: 60 min, 1,999,900 tokens/);
    expect(cont.text).toMatch(/Last progress note: Updated two entries\./);
    expect(blocks).toContain('Goal:true');
    const done = await e.runs.get(ACCOUNT, v.id);
    expect(done.status).toBe('done');
    const g = (await e.runs.getRunGoal(ACCOUNT, v.id))!;
    expect(g).toMatchObject({
      status: 'complete',
      statusSetBy: 'agent',
      completionSummary: 'All entries match.',
    });
    expect(e.audit.filter((a) => a.action === 'goal.status').map((a) => a.detail)).toContainEqual(
      expect.objectContaining({ from: 'active', to: 'complete' }),
    );
    expect(e.env.events.names()).toContain('goal.status.changed');
  });

  it('a user message takes precedence over the continuation', async () => {
    const v = await goalRun(async () => ({ reply: 'step' }));
    // Queued input waits: no continuation starts while it is pending.
    e.env.db.raw
      .prepare(
        "INSERT INTO queued_input (id, thread_id, account_id, text, status, created_at, updated_at) VALUES ('q1', ?, ?, 'hi', 'pending', 'x', 'x')",
      )
      .run(v.threadId, ACCOUNT);
    const before = e.turns.started.length;
    await e.clock.advance(10_000, () => e.settle());
    expect(e.turns.started.length).toBe(before);
  });

  it('a paused goal does not continue; resuming continues it', async () => {
    const v = await goalRun(async () => ({ reply: 'step' }));
    const g = (await e.runs.getRunGoal(ACCOUNT, v.id))!;
    const paused = await e.runs.goalAction(ACCOUNT, g.id, 'pause');
    expect(paused).toMatchObject({ status: 'paused', statusSetBy: 'user' });
    const before = e.turns.started.length;
    await e.clock.advance(60_000, () => e.settle());
    expect(e.turns.started.length).toBe(before);
    // A paused goal is not blocked; the run shows Ready (a badge in the UI).
    expect((await e.runs.get(ACCOUNT, v.id)).derived.status).toBe('ready');
    e.turns.script = async (t) => {
      await t.call('goal.update', { status: 'complete', progressNote: 'done' });
      return { reply: 'ok' };
    };
    await e.runs.goalAction(ACCOUNT, g.id, 'resume');
    await e.clock.advance(5_000, () => e.settle());
    expect(e.turns.started.length).toBe(before + 1);
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
  });

  it('the user completing or clearing the goal finishes an idle run', async () => {
    const a = await goalRun(async () => ({ reply: 'progress' }));
    const ga = (await e.runs.getRunGoal(ACCOUNT, a.id))!;
    await e.runs.goalAction(ACCOUNT, ga.id, 'complete');
    expect(await e.runs.get(ACCOUNT, a.id)).toMatchObject({
      status: 'done',
      result: { summary: 'progress' },
    });
    const b = await goalRun(async () => ({ reply: 'more' }));
    await e.runs.clearRunGoal(ACCOUNT, b.id);
    expect((await e.runs.get(ACCOUNT, b.id)).status).toBe('done');
    expect(await e.runs.getRunGoal(ACCOUNT, b.id)).toBeNull();
    expect(e.audit.map((x) => x.action)).toContain('goal.clear');
  });
});

describe('the blocked rule (enforced by the runtime)', () => {
  it('accepts blocked only after the same blocker on 3 consecutive goal turns', async () => {
    const results: string[] = [];
    const blocked = (t: FakeTurn) =>
      t
        .call('goal.update', {
          blocker: { key: 'No access to the repo!', description: 'The token was revoked' },
          status: 'blocked',
        })
        .then((r) => {
          results.push(r.ok ? text(r) : `refused: ${r.error.message}`);
          return { reply: 'blocked' };
        });
    const v = await goalRun(blocked);
    await e.clock.advance(5_000, () => e.settle());
    await e.clock.advance(5_000, () => e.settle());
    expect(results[0]).toMatch(/now 1\)$/);
    expect(results[1]).toMatch(/now 2\)$/);
    expect(results[2]).toBe('Goal is blocked.');
    const g = (await e.runs.getRunGoal(ACCOUNT, v.id))!;
    expect(g).toMatchObject({
      status: 'blocked',
      statusSetBy: 'agent',
      statusReason: 'The token was revoked',
      blocker: { key: 'no-access-to-the-repo', count: 3 },
    });
    // No continuation while blocked; the thread shows Blocked; the user is told.
    const before = e.turns.started.length;
    await e.clock.advance(60_000, () => e.settle());
    expect(e.turns.started.length).toBe(before);
    const run = await e.runs.get(ACCOUNT, v.id);
    expect(run).toMatchObject({
      status: 'running',
      derived: { status: 'blocked', reason: 'Goal blocked' },
    });
    expect(await e.runs.status.blocked(ACCOUNT, [v.threadId])).toEqual(
      new Map([[v.threadId, 'Goal blocked']]),
    );
    expect(e.notes.map((n) => n.title)).toContain('Goal blocked');
    const blockedEvent = e.env.events.events.find(
      (x) => x.name === 'goal.status.changed' && x.payload.to === 'blocked',
    );
    expect(blockedEvent?.payload).toMatchObject({
      setBy: 'agent',
      blocker: { key: 'no-access-to-the-repo' },
    });
    // Resuming resets the count.
    e.turns.script = async () => ({ reply: 'trying again' });
    const resumed = await e.runs.goalAction(ACCOUNT, g.id, 'resume');
    expect(resumed).toMatchObject({ status: 'active', blocker: null });
    await e.clock.advance(5_000, () => e.settle());
    expect(e.turns.started.length).toBe(before + 1);
  });

  it('a goal turn without the blocker, or with another key, restarts the count', async () => {
    let turn = 0;
    const keys = ['quota', 'quota', null, 'quota', 'disk', 'disk'];
    const counts: number[] = [];
    const v = await goalRun(async (t) => {
      const key = keys[turn++];
      if (key) await t.call('goal.update', { blocker: { key } });
      const g = await e.runs.getRunGoal(ACCOUNT, t.input.runId!);
      counts.push(g?.blocker?.count ?? 0);
      return { reply: 'x' };
    });
    for (let i = 0; i < 5; i++) await e.clock.advance(5_000, () => e.settle());
    expect(counts).toEqual([1, 2, 2, 1, 1, 2]);
    expect((await e.runs.getRunGoal(ACCOUNT, v.id))?.blocker?.count).toBe(2);
  });

  it('pure rules', () => {
    expect(normalizeBlockerKey('  Rate LIMIT: 429 ')).toBe('rate-limit-429');
    expect(
      nextBlockerCount({ blockerKey: 'a', blockerCount: 2, blockerTurnId: 't1' }, 'a', 't1'),
    ).toBe(2);
    expect(
      nextBlockerCount({ blockerKey: 'a', blockerCount: 2, blockerTurnId: 't1' }, 'a', 't2'),
    ).toBe(3);
    expect(
      nextBlockerCount({ blockerKey: 'a', blockerCount: 2, blockerTurnId: 't1' }, 'b', 't2'),
    ).toBe(1);
    const g = { status: 'active' as const, blockerCount: 0 };
    expect(checkAgentStatus(g, 'budget_limited', { userAsked: true, hasSummary: true }).ok).toBe(
      false,
    );
    expect(checkAgentStatus(g, 'usage_limited', { userAsked: true, hasSummary: true }).ok).toBe(
      false,
    );
    expect(checkAgentStatus(g, 'active', { userAsked: true, hasSummary: true }).ok).toBe(true);
    expect(
      checkAgentStatus({ ...g, status: 'paused' }, 'active', { userAsked: true, hasSummary: true })
        .ok,
    ).toBe(false);
    expect(checkAgentStatus(g, 'paused', { userAsked: false, hasSummary: true }).ok).toBe(false);
    expect(checkAgentStatus(g, 'paused', { userAsked: true, hasSummary: true }).ok).toBe(true);
    expect(checkAgentStatus(g, 'complete', { userAsked: false, hasSummary: false }).ok).toBe(false);
    expect(goalUserTransition('complete', 'pause')).toBeNull();
    expect(goalUserTransition('active', 'resume')).toBeNull();
    expect(goalUserTransition('blocked', 'resume')).toBe('active');
    expect(goalUserTransition('complete', 'complete')).toBeNull();
    expect(goalUserTransition('budget_limited', 'complete')).toBe('complete');
  });
});

describe('goal tools', () => {
  it('refuses status changes the agent may not make', async () => {
    const out: string[] = [];
    await goalRun(async (t) => {
      for (const status of ['paused', 'complete'] as const) {
        const r = await t.call('goal.update', { status });
        out.push(r.ok ? 'ok' : r.error.code);
      }
      const get = await t.call('goal.get');
      out.push(JSON.parse(text(get)).status as string);
      return { reply: 'x' };
    });
    // paused: not asked in this turn (a goal continuation has no user words); complete: no note.
    // The first turn here carries the user's objective, so pausing is allowed only then.
    expect(out).toEqual(['ok', 'status_refused', 'paused']);
  });

  it('goal.set works only when the user asked for a goal in this run', async () => {
    const results: string[] = [];
    e.turns.script = async (t) => {
      const r = await t.call('goal.set', {
        objective: 'Ship the docs',
        budgets: { tokens: 50_000 },
      });
      results.push(r.ok ? 'ok' : r.error.code);
      return { reply: 'x' };
    };
    // The user typed the objective: allowed.
    const mine = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Set a goal to ship the docs',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
    });
    await e.settle();
    // A model-written objective: refused.
    await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Set a goal',
      origin: 'chat_escalation',
      authority: { kind: 'none', origin: 'system' },
      start: true,
    });
    await e.settle();
    expect(results).toEqual(['ok', 'not_requested']);
    const g = (await e.runs.getRunGoal(ACCOUNT, mine.id))!;
    expect(g).toMatchObject({ objective: 'Ship the docs', budgets: { tokens: 50_000 } });
    // An agent-written goal objective is untrusted context.
    let trusted: boolean | undefined;
    e.turns.script = async (t) => {
      trusted = t.addition?.context?.find((b) => b.label === 'Goal')?.trusted;
      await t.call('goal.update', { status: 'complete', progressNote: 'Shipped.' });
      return { reply: 'ok' };
    };
    await e.clock.advance(5_000, () => e.settle());
    expect(trusted).toBe(false);
  });

  it('the goal tools exist only in run threads', async () => {
    const chat = await e.env.threads.create(ACCOUNT, { mode: 'chat' });
    const tools = await e.runs.toolSource.list(ACCOUNT);
    for (const name of ['goal.get', 'goal.set', 'goal.update']) {
      const r = await tools
        .find((t) => t.descriptor.name === name)!
        .handler({}, { threadId: chat.id, accountId: ACCOUNT, turnId: 't' } as never);
      expect(r).toMatchObject({ ok: false, error: { code: 'not_in_run' } });
    }
  });
});

describe('goal routes logic', () => {
  it('sets, edits, lists, and never lets the user set system statuses', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return { reply: 'x' };
    };
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Watch the build',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
    });
    const g = await e.runs.setRunGoal(ACCOUNT, v.id, { objective: 'Green build' });
    expect(g).toMatchObject({ status: 'active', objective: 'Green build', budgets: {} });
    const again = await e.runs.setRunGoal(ACCOUNT, v.id, {
      objective: 'Green build on main',
      budgets: { timeSeconds: 600 },
    });
    expect(again.id).toBe(g.id);
    const edited = await e.runs.updateGoal(ACCOUNT, g.id, { objective: 'Green main' });
    expect(edited).toMatchObject({ objective: 'Green main', budgets: { timeSeconds: 600 } });
    expect((await e.runs.listGoals(ACCOUNT, 'active')).map((x) => x.id)).toEqual([g.id]);
    expect(await e.runs.listGoals(ACCOUNT, 'blocked')).toEqual([]);
    expect((await e.runs.get(ACCOUNT, v.id)).goalId).toBe(g.id);
    // Nothing the user does reaches usage_limited or budget_limited.
    for (const action of ['pause', 'resume', 'complete'] as const) {
      const r = await e.runs.goalAction(ACCOUNT, g.id, action);
      expect(['paused', 'active', 'complete']).toContain(r.status);
    }
    await expect(e.runs.getGoal('other', g.id)).rejects.toMatchObject({ code: 'not_found' });
    e.turns.release(v.threadId);
    await e.settle();
    await expect(e.runs.setRunGoal(ACCOUNT, v.id, { objective: 'late' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
