// Budgeted execution (FR-182, ADR-058, docs/09 §2): time (active time only), tokens and cost are
// checked before every model step; reaching a bound pauses with a progress summary and an offer
// to extend; nothing continues until the user extends it; the 200-step backstop the same way.
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, makeRunsEnv, type RunsEnv } from './runs-env.ts';

let e: RunsEnv;

beforeEach(async () => {
  e = await makeRunsEnv();
});

afterEach(async () => {
  await e.close();
});

async function create(budgets: { timeSeconds?: number; tokens?: number; costUsd?: number | null }) {
  return e.runs.create({
    accountId: ACCOUNT,
    objective: 'Summarize the attached report',
    origin: 'user',
    authority: { kind: 'user', source: 'test' },
    start: true,
    budgets,
  });
}

/** Steps of two minutes each until a bound stops the turn, or `max` steps. */
function stepper(max = 100, minutes = 2, reply = '') {
  e.turns.script = async (t) => {
    for (let i = 0; i < max; i++) if (!t.step({ activeMs: minutes * 60_000 })) break;
    return { reply };
  };
}

describe('time budget (J5 step 3)', () => {
  it('pauses at 10 minutes with a summary; nothing runs until the user extends it', async () => {
    e.turns.script = async (t) => {
      await t.call('plan.set', { steps: [{ title: 'Read' }, { title: 'Write' }] });
      for (let i = 0; i < 100; i++) if (!t.step({ activeMs: 2 * 60_000 })) break;
      return { reply: '' };
    };
    const v = await create({ timeSeconds: 600 });
    await e.settle();
    const paused = await e.runs.get(ACCOUNT, v.id);
    expect(paused).toMatchObject({
      status: 'paused',
      pauseReason: 'budget_time',
      derived: { status: 'blocked', reason: 'Budget reached' },
      used: { timeSeconds: 600 },
    });
    // No reply: a summary written without another model call.
    const reached = e.env.events.events.find((x) => x.name === 'run.budget.reached')!;
    expect(reached.payload).toMatchObject({ bound: 'time' });
    expect(String(reached.payload.summary)).toMatch(
      /^Paused \(budget reached\) after 5 model steps\. Plan: 0 of 2 steps done\. Next: Read\./,
    );
    expect(e.turns.outcomes.at(-1)).toMatchObject({
      stop: 'budget',
      bound: { bound: 'time', used: 600, limit: 600 },
    });
    expect(e.notes.map((n) => n.title)).toContain('Budget reached');
    // Nothing continues silently: no timer or turn is waiting.
    const turns = e.turns.started.length;
    await e.clock.advance(60 * 60_000, () => e.settle());
    expect(e.turns.started.length).toBe(turns);
    await expect(e.runs.resume(ACCOUNT, v.id)).rejects.toMatchObject({
      code: 'budget_exhausted',
      details: { bound: 'time' },
    });
    // A redirect waits for the extension.
    await e.runs.redirect(ACCOUNT, v.id, 'Keep it short');
    expect(e.turns.started.length).toBe(turns);
    e.turns.script = async (t) => {
      t.step({ activeMs: 60_000 });
      return { reply: 'Finished after the extension.' };
    };
    const extended = await e.runs.extendBudget(ACCOUNT, v.id, { timeSeconds: 600 });
    expect(extended.budgets.timeSeconds).toBe(1200);
    expect(e.turns.started.at(-1)).toMatchObject({ text: 'Keep it short', authorKind: 'user' });
    await e.settle();
    const done = await e.runs.get(ACCOUNT, v.id);
    expect(done.status).toBe('done');
    expect(done.used.timeSeconds).toBe(660);
    expect(e.env.events.names()).toContain('run.budget.extended');
    expect(e.audit.map((a) => a.action)).toContain('run.budget.extend');
  });

  it('keeps the last reply as the progress summary', async () => {
    stepper(100, 2, 'Read half of it so far.');
    const v = await create({ timeSeconds: 300 });
    await e.settle();
    const reached = e.env.events.events.find((x) => x.name === 'run.budget.reached')!;
    expect(reached.payload.summary).toBe('Read half of it so far.');
    stepper(1);
    // An extension too small to fit leaves the run paused.
    const still = await e.runs.extendBudget(ACCOUNT, v.id, { tokens: 1000 });
    expect(still.status).toBe('paused');
    await e.runs.extendBudget(ACCOUNT, v.id, { timeSeconds: 300 });
    await e.settle();
    expect(e.turns.started.at(-1)?.text).toMatch(/Last progress: Read half of it so far\./);
  });
});

describe('tokens and cost', () => {
  it('pauses on the token budget, counting live usage', async () => {
    e.turns.script = async (t) => {
      for (let i = 0; i < 10; i++) if (!t.step({ tokens: 400, activeMs: 10 })) break;
      return { reply: 'partial' };
    };
    const v = await create({ tokens: 1000 });
    await e.settle();
    const r = await e.runs.get(ACCOUNT, v.id);
    expect(r).toMatchObject({
      status: 'paused',
      pauseReason: 'budget_tokens',
      used: { tokens: 1200 },
    });
    const usage = e.env.events.events.filter((x) => x.name === 'run.budget.usage');
    expect(usage.length).toBeGreaterThanOrEqual(3);
    expect(usage.every((x) => x.ephemeral)).toBe(true);
    expect(usage.at(-1)?.payload).toMatchObject({
      usage: { tokens: 1200 },
      budgets: { tokens: 1000 },
    });
  });

  it('pauses on the cost budget; a null cost budget is no cap', async () => {
    e.turns.script = async (t) => {
      for (let i = 0; i < 5; i++) if (!t.step({ costUsd: 0.5 })) break;
      return { reply: 'x' };
    };
    const capped = await create({ costUsd: 1 });
    await e.settle();
    expect(await e.runs.get(ACCOUNT, capped.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'budget_cost',
      used: { costUsd: 1 },
    });
    const free = await create({ costUsd: null });
    await e.settle();
    expect(await e.runs.get(ACCOUNT, free.id)).toMatchObject({
      status: 'done',
      budgets: { costUsd: null },
      used: { costUsd: 2.5 },
    });
    // Extending a cost cap resumes.
    e.turns.script = async () => ({ reply: 'ok' });
    await e.runs.extendBudget(ACCOUNT, capped.id, { costUsd: 5 });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, capped.id)).status).toBe('done');
  });
});

describe('the 200-step backstop', () => {
  it('pauses on the backstop; one more turn of steps resumes it', async () => {
    e.turns.script = async () => ({ stop: 'backstop', reply: 'Still working.' });
    const v = await create({});
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'backstop',
      derived: { status: 'blocked', reason: 'Step limit reached' },
    });
    expect(e.env.events.events.find((x) => x.name === 'run.budget.reached')?.payload).toMatchObject(
      {
        bound: 'backstop',
      },
    );
    // Extending another bound does not count as the step extension.
    const same = await e.runs.extendBudget(ACCOUNT, v.id, { tokens: 1000 });
    expect(same.status).toBe('paused');
    e.turns.script = async () => ({ reply: 'Done now.' });
    await e.runs.extendBudget(ACCOUNT, v.id, { steps: true });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
    await expect(e.runs.extendBudget(ACCOUNT, v.id, { steps: true })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('goal budgets', () => {
  it('a run budget pause moves the goal to budget_limited (system only)', async () => {
    stepper();
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Keep the changelog current',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      budgets: { timeSeconds: 300 },
      goal: { objective: 'Keep the changelog current' },
    });
    await e.settle();
    const goal = await e.runs.getRunGoal(ACCOUNT, v.id);
    expect(goal).toMatchObject({ status: 'budget_limited', statusSetBy: 'system' });
    expect(goal?.usage.timeSeconds).toBe(360);
    // The user can resume the goal only after extending.
    stepper(1, 1, 'ok');
    await e.runs.extendBudget(ACCOUNT, v.id, { timeSeconds: 600 });
    expect((await e.runs.getRunGoal(ACCOUNT, v.id))?.status).toBe('active');
    await e.settle();
  });

  it("a goal's own budget stops the run before the run's budget", async () => {
    stepper();
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'Triage the inbox',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      goal: { objective: 'Triage the inbox', budgets: { timeSeconds: 240 } },
    });
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'budget_time',
      used: { timeSeconds: 240 },
    });
    const g = (await e.runs.getRunGoal(ACCOUNT, v.id))!;
    expect(g.status).toBe('budget_limited');
    // Extending only the run does not lift the goal's own cap.
    const r = await e.runs.extendBudget(ACCOUNT, v.id, { timeSeconds: 600 });
    expect(r.status).toBe('paused');
    await expect(e.runs.goalAction(ACCOUNT, g.id, 'resume')).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
    stepper(1, 1, 'done');
    await e.runs.updateGoal(ACCOUNT, g.id, { budgets: { timeSeconds: 3600 } });
    const resumed = await e.runs.goalAction(ACCOUNT, g.id, 'resume');
    expect(resumed.status).toBe('active');
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('running');
    await e.settle();
  });
});
