// Work run lifecycle (FR-051, FR-052, FR-057, FR-058, FR-187, docs/09 §2-§3, §12): plan, tool
// calls with an approval, an artifact and the structured result; autonomy levels; pause, resume,
// redirect and cancel; errors and approval timeouts; verified outputs; restart recovery.
/* eslint-disable @typescript-eslint/require-await */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, type EventEnvelope } from '@nova/shared';
import { RunService, runActivity } from '../src/index.ts';
import { ACCOUNT, eventNames, makeRunsEnv, type RunsEnv } from './runs-env.ts';

let e: RunsEnv;

beforeEach(async () => {
  e = await makeRunsEnv();
});

afterEach(async () => {
  await e.close();
});

const user = (source = 'test') => ({ kind: 'user' as const, source });

async function create(over: Partial<Parameters<RunsEnv['runs']['create']>[0]> = {}) {
  const v = await e.runs.create({
    accountId: ACCOUNT,
    objective: 'Summarize the report and save a Markdown artifact',
    origin: 'user',
    authority: user(),
    start: true,
    ...over,
  });
  return v;
}

describe('a Work run (FR-051)', () => {
  it('plans, calls tools with one approval, saves an artifact and reports the result', async () => {
    let released: (() => Promise<void>) | null = null;
    e.turns.script = async (t) => {
      t.step();
      await t.call('plan.set', {
        steps: [{ title: 'Read the report' }, { title: 'Summarize' }, { title: 'Save it' }],
      });
      for (let i = 0; i < 3; i++) {
        await t.call('plan.update', { idx: i, status: 'running' });
        t.step();
        if (i === 1) {
          released = await t.waitApproval();
          await t.hold();
          await released();
        }
        await t.call('plan.update', { idx: i, status: 'done', detail: `step ${i} ok` });
      }
      const id = await t.saveArtifact('Summary');
      const r = await t.call('run.complete', {
        summary: 'Summarized in one page.',
        artifactIds: [id],
        evidence: ['the artifact preview renders'],
      });
      expect(r.ok).toBe(true);
      return { reply: 'All done.' };
    };
    const created = await create({ expectedOutput: { kind: 'artifact', ref: 'summary' } });
    expect(created.status).toBe('running');
    // The first turn carries the objective with the user's authority (FR-189).
    const first = e.turns.started[0]!;
    expect(first).toMatchObject({
      text: created.objective,
      trigger: 'user',
      authorKind: 'run',
      runId: created.id,
      authority: { kind: 'user', source: 'test' },
    });
    await waitUntil(() => e.turns.isHeld(created.threadId));
    const waiting = await e.runs.get(ACCOUNT, created.id);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.derived).toEqual({ status: 'needs_input', reason: 'Approval needed' });
    expect(waiting.plan?.map((s) => s.status)).toEqual(['done', 'running', 'pending']);
    e.turns.release(created.threadId);
    await e.settle();
    const done = await e.runs.get(ACCOUNT, created.id);
    expect(done.status).toBe('done');
    expect(done.outputVerifiedAt).not.toBeNull();
    expect(done.result?.summary).toBe('Summarized in one page.');
    expect(done.result?.artifactIds).toHaveLength(1);
    expect(done.result?.evidence[0]).toBe('the artifact preview renders');
    expect(done.result?.evidence[1]).toMatch(/^artifact .* saved$/);
    expect(done.plan?.every((s) => s.status === 'done')).toBe(true);
    expect(done.derived.status).toBe('ready');
    expect(done.used.tokens).toBe(400);
    expect(done.used.timeSeconds).toBe(4);
    const statuses = e.env.events.events
      .filter((x) => x.name === 'run.status.changed')
      .map((x) => `${String(x.payload.from)}>${String(x.payload.to)}`);
    expect(statuses).toEqual([
      'running>waiting_approval',
      'waiting_approval>running',
      'running>done',
    ]);
    expect(eventNames(e.env, 'run.')).toEqual(
      expect.arrayContaining([
        'run.created',
        'run.plan.proposed',
        'run.step.started',
        'run.step.completed',
        'run.completed',
        'run.updated',
        'run.budget.usage',
      ]),
    );
    const completed = e.env.events.events.find((x) => x.name === 'run.completed')!;
    expect(completed.payload).toMatchObject({ status: 'done', outputVerified: true });
    expect(completed.ephemeral).toBe(false);
    expect(e.env.events.events.find((x) => x.name === 'run.updated')!.ephemeral).toBe(true);
    expect(e.audit.map((a) => a.action)).toContain('run.create');
    expect(e.notes.map((n) => n.title)).toContain('Run finished');
    expect(await e.runs.whenFinished(ACCOUNT, created.id)).toMatchObject({
      status: 'done',
      summary: 'Summarized in one page.',
    });
  });

  it('gives the model its objective, how to run and the plan as context', async () => {
    let blocks: { label: string; trusted: boolean }[] = [];
    e.turns.script = async (t) => {
      await t.call('plan.set', { steps: [{ title: 'One', detail: 'first' }] });
      return { reply: 'ok' };
    };
    const v = await create();
    await e.settle();
    e.turns.script = async (t) => {
      blocks = (t.addition?.context ?? []).map((b) => ({ label: b.label, trusted: b.trusted }));
      return { reply: 'ok' };
    };
    // A finished run's thread is an ordinary thread again.
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
    const second = await create({ authority: { kind: 'none', origin: 'system' } });
    await e.settle();
    expect(second.status).toBe('running');
    expect(blocks).toEqual([
      { label: 'Run objective', trusted: false },
      { label: 'How to run', trusted: true },
      { label: 'Budget', trusted: true },
    ]);
  });

  it('ends output_missing when the declared artifact was not saved (FR-187)', async () => {
    e.turns.script = async () => ({ reply: 'I could not save it.' });
    const v = await create({ expectedOutput: { kind: 'artifact' } });
    await e.settle();
    const r = await e.runs.get(ACCOUNT, v.id);
    expect(r.status).toBe('output_missing');
    expect(r.outputVerifiedAt).toBeNull();
    expect(r.derived).toEqual({ status: 'blocked', reason: 'Output missing' });
    expect(r.result?.summary).toBe('I could not save it.');
    expect(e.notes.map((n) => n.title)).toContain('Run output missing');
  });

  it('verifies a file output by hashing it, inside the run roots', async () => {
    const root = join(e.dataDir, 'files');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });
    const runs = e.restart({
      roots: () => Promise.resolve([{ path: root, access: 'write', label: 'Files' }]),
    });
    e.turns.script = async () => {
      writeFileSync(join(root, 'out.txt'), 'hello');
      return { reply: 'written' };
    };
    const ok = await runs.create({
      accountId: ACCOUNT,
      objective: 'Write out.txt',
      origin: 'user',
      authority: user(),
      start: true,
      expectedOutput: { kind: 'file', ref: 'out.txt' },
    });
    await e.settle();
    const r = await runs.get(ACCOUNT, ok.id);
    expect(r.status).toBe('done');
    expect(r.result?.evidence.at(-1)).toMatch(
      /sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824$/,
    );
    e.turns.script = async () => ({ reply: 'forgot' });
    const missing = await runs.create({
      accountId: ACCOUNT,
      objective: 'Write missing.txt',
      origin: 'user',
      authority: user(),
      start: true,
      expectedOutput: { kind: 'file', ref: '../outside.txt' },
    });
    await e.settle();
    expect((await runs.get(ACCOUNT, missing.id)).status).toBe('output_missing');
  });

  it('verifies a message output by the reply, or by the delivery receipt for schedules', async () => {
    e.turns.script = async () => ({ reply: 'Here is the news.' });
    const plain = await create({ expectedOutput: { kind: 'message' } });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, plain.id)).status).toBe('done');
    // A scheduled run without a receipt never reads done (J5 step 5).
    const sched = await create({
      origin: 'schedule',
      originRef: 'sched-1',
      expectedOutput: { kind: 'message' },
    });
    await e.settle();
    expect(e.turns.started.at(-1)).toMatchObject({ trigger: 'schedule', authorKind: 'schedule' });
    const missing = await e.runs.get(ACCOUNT, sched.id);
    expect(missing.status).toBe('output_missing');
    e.runs.useDelivery(async (input) =>
      input.originRef === 'sched-1'
        ? { ok: true, evidence: 'delivered: receipt r-1' }
        : { ok: false, reason: 'no receipt' },
    );
    const delivered = await create({
      origin: 'schedule',
      originRef: 'sched-1',
      expectedOutput: { kind: 'message' },
    });
    await e.settle();
    const r = await e.runs.get(ACCOUNT, delivered.id);
    expect(r.status).toBe('done');
    expect(r.result?.evidence).toContain('delivered: receipt r-1');
  });

  it('lists active and all runs with a cursor, scoped to the account', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return { reply: 'ok' };
    };
    const a = await create({ title: 'A' });
    e.turns.script = async () => ({ reply: 'ok' });
    const b = await create({ title: 'B' });
    await e.runs.whenFinished(ACCOUNT, b.id);
    const active = await e.runs.list(ACCOUNT, { status: 'active' });
    expect(active.items.map((r) => r.id)).toEqual([a.id]);
    e.turns.release(a.threadId);
    await e.settle();
    const page1 = await e.runs.list(ACCOUNT, { status: 'all', limit: 1 });
    expect(page1.items).toHaveLength(1);
    const page2 = await e.runs.list(ACCOUNT, { status: 'all', cursor: page1.nextCursor! });
    expect([...page1.items, ...page2.items].map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    await expect(e.runs.get('someone-else', a.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(e.runs.list(ACCOUNT, { cursor: 'bad' })).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('autonomy (docs/09 §3)', () => {
  it('ask_first: the first turn only plans, the run waits until Start', async () => {
    e.settings.autonomy = 'ask_first';
    let how = '';
    e.turns.script = async (t) => {
      how = t.addition?.context?.find((b) => b.label === 'How to run')?.text ?? '';
      const r = await t.call('plan.set', { steps: [{ title: 'Look' }, { title: 'Write' }] });
      expect(r.ok && r.content[0]?.type === 'text' ? r.content[0].text : '').toMatch(/stop here/);
      return { reply: 'The plan is ready.' };
    };
    const v = await create();
    expect(v.status).toBe('planning');
    await e.settle();
    expect(how).toMatch(/only propose a plan/);
    const waiting = await e.runs.get(ACCOUNT, v.id);
    expect(waiting.status).toBe('planning');
    expect(waiting.planApproved).toBe(false);
    expect(waiting.derived).toEqual({ status: 'needs_input', reason: 'Plan ready for review' });
    expect(e.notes.map((n) => n.title)).toContain('Plan ready');
    let blocks: { label: string; trusted: boolean }[] = [];
    e.turns.script = async (t) => {
      blocks = (t.addition?.context ?? []).map((b) => ({ label: b.label, trusted: b.trusted }));
      return { reply: 'Carried out.' };
    };
    const started = await e.runs.start(ACCOUNT, v.id);
    expect(started.planApproved).toBe(true);
    expect(e.turns.started.at(-1)).toMatchObject({
      text: 'The plan is approved. Carry it out now.',
      authority: { kind: 'user', source: `run:${v.id}:start` },
    });
    await e.settle();
    expect(blocks).toContainEqual({ label: 'Approved plan', trusted: true });
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
    await expect(e.runs.start(ACCOUNT, v.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(e.audit.map((a) => a.action)).toContain('run.start');
  });

  it('standard: the plan is shown and the run proceeds; the user may edit it', async () => {
    e.turns.script = async (t) => {
      await t.call('plan.set', { steps: [{ title: 'A' }, { title: 'B' }] });
      await t.hold();
      return { reply: 'ok' };
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    const edited = await e.runs.setPlan(ACCOUNT, v.id, [
      { title: 'A' },
      { title: 'B2', detail: 'changed' },
    ]);
    expect(edited.plan?.map((s) => s.title)).toEqual(['A', 'B2']);
    expect(edited.planApproved).toBe(true);
    expect(eventNames(e.env, 'run.plan')).toEqual(['run.plan.proposed', 'run.plan.amended']);
    e.turns.release(v.threadId);
    await e.settle();
    await expect(e.runs.setPlan(ACCOUNT, v.id, [{ title: 'late' }])).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('maps autonomy to the approval policy, and refuses plan tools outside runs', async () => {
    const v = await create({ autonomy: 'autonomous' });
    await e.settle();
    expect(await e.runs.policy.forThread(ACCOUNT, v.threadId)).toMatchObject({
      approvalPolicy: 'review',
      profileId: null,
    });
    expect(await e.runs.policy.forThread(ACCOUNT, 'nope')).toBeNull();
    const chat = await e.env.threads.create(ACCOUNT, { mode: 'chat' });
    const tool = (await e.runs.toolSource.list(ACCOUNT)).find(
      (t) => t.descriptor.name === 'plan.set',
    )!;
    expect(tool.descriptor.annotations).toMatchObject({ readOnly: true });
    const r = await tool.handler(
      { steps: [{ title: 'x' }] },
      {
        accountId: ACCOUNT,
        threadId: chat.id,
        turnId: 't',
        callId: 'c',
        projectId: null,
        origin: 'model',
        profile: { id: 'p', hash: 'h' },
        roots: [],
        sandbox: {} as never,
        signal: new AbortController().signal,
        log: {} as never,
      },
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'not_in_run' } });
    expect((await e.runs.toolsFor(ACCOUNT, v.threadId)).map((t) => t.descriptor.name)).toContain(
      'task.spawn',
    );
  });
});

describe('control: pause, resume, redirect, cancel (FR-019, FR-090)', () => {
  it('pause cancels the turn; resume continues with the plan and progress', async () => {
    e.turns.script = async (t) => {
      t.step();
      await t.hold();
      return { reply: 'partial' };
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    const paused = await e.runs.pause(ACCOUNT, v.id);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'user' });
    await e.settle();
    expect(e.turns.outcomes.at(-1)?.stop).toBe('cancelled');
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('paused');
    expect((await e.runs.get(ACCOUNT, v.id)).derived.status).toBe('ready');
    await expect(e.runs.start(ACCOUNT, v.id)).rejects.toMatchObject({ code: 'conflict' });
    e.turns.script = async () => ({ reply: 'finished' });
    await e.runs.resume(ACCOUNT, v.id);
    expect(e.turns.started.at(-1)).toMatchObject({
      text: expect.stringMatching(/^Continue the run/),
      authority: { kind: 'user', source: `run:${v.id}:resume` },
    });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
    await expect(e.runs.resume(ACCOUNT, v.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(e.runs.pause(ACCOUNT, v.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(e.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['run.pause', 'run.resume']),
    );
  });

  it('a resumed model-written run keeps no user authority (FR-189)', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return {};
    };
    const v = await create({ authority: { kind: 'none', origin: 'system' } });
    await waitUntil(() => e.turns.isHeld(v.threadId));
    await e.runs.pause(ACCOUNT, v.id);
    await e.settle();
    e.turns.script = async () => ({ reply: 'ok' });
    await e.runs.resume(ACCOUNT, v.id);
    expect(e.turns.started.at(-1)?.authority).toEqual({ kind: 'none', origin: 'system' });
    await e.settle();
  });

  it('a redirect while a turn runs starts after it, with the user authority', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return { reply: 'first' };
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    await e.runs.redirect(ACCOUNT, v.id, 'Use the newer report instead');
    e.turns.script = async () => ({ reply: 'redirected' });
    e.turns.release(v.threadId);
    await e.settle();
    expect(e.turns.started.at(-1)).toMatchObject({
      text: 'Use the newer report instead',
      authorKind: 'user',
      authority: { kind: 'user', source: `run:${v.id}:redirect` },
    });
    const r = await e.runs.get(ACCOUNT, v.id);
    expect(r.status).toBe('done');
    expect(r.result?.summary).toBe('redirected');
    expect(e.audit.find((a) => a.action === 'run.redirect')?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a redirect on a paused run continues it at once', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return {};
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    await e.runs.pause(ACCOUNT, v.id);
    await e.settle();
    e.turns.script = async () => ({ reply: 'ok' });
    const r = await e.runs.redirect(ACCOUNT, v.id, 'go on, but shorter');
    expect(r.status).toBe('running');
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
  });

  it('cancel ends the run and settles whenFinished', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return {};
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    const fin = e.runs.whenFinished(ACCOUNT, v.id);
    const c = await e.runs.cancel(ACCOUNT, v.id);
    expect(c.status).toBe('cancelled');
    expect(await fin).toMatchObject({ status: 'cancelled' });
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('cancelled');
    // Idempotent; and nothing else may change it.
    expect((await e.runs.cancel(ACCOUNT, v.id)).status).toBe('cancelled');
    await expect(e.runs.redirect(ACCOUNT, v.id, 'x')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the user pressing Stop in the thread pauses the run', async () => {
    e.turns.script = async (t) => {
      await t.hold();
      return {};
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    await e.turns.cancel(ACCOUNT, v.threadId);
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
    });
  });
});

describe('failures (docs/09 §12, FR-058)', () => {
  it('an error pauses the run; three in a row fail it', async () => {
    e.turns.script = async () => ({
      stop: 'error',
      error: { code: 'provider_error', message: 'boom' },
    });
    const v = await create();
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'error',
      derived: { status: 'blocked', reason: 'Error' },
    });
    await e.runs.resume(ACCOUNT, v.id);
    await e.settle();
    await e.runs.resume(ACCOUNT, v.id);
    await e.settle();
    const failed = await e.runs.get(ACCOUNT, v.id);
    expect(failed.status).toBe('failed');
    expect(failed.derived).toEqual({ status: 'blocked', reason: 'Run failed' });
    expect(await e.runs.whenFinished(ACCOUNT, v.id)).toMatchObject({ status: 'failed' });
  });

  it('an approval timeout pauses the run until the user resumes it', async () => {
    e.turns.script = async () => ({ stop: 'approval_timeout' });
    const v = await create();
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'approval_timeout',
      derived: { status: 'blocked', reason: 'Approval timed out' },
    });
    expect(e.notes.map((n) => n.title)).toContain('Approval timed out');
  });

  it('a provider usage limit pauses the run and tries again later', async () => {
    e.turns.script = async () => ({
      stop: 'error',
      error: { code: 'rate_limited', message: 'slow down' },
    });
    const v = await create();
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'usage_limit',
    });
    e.turns.script = async () => ({ reply: 'ok' });
    await e.clock.advance(15 * 60_000, () => e.settle());
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
  });

  it('a lost execution location pauses with an error', async () => {
    e.turns.script = async () => ({ stop: 'location_lost' });
    const v = await create();
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'error',
    });
  });

  it('a run without a turn starter pauses with an error instead of hanging', async () => {
    // A supervisor whose chat loop is not bound yet cannot start turns.
    const lone = new RunService({
      db: e.env.db,
      events: e.env.events,
      threads: e.env.threads,
      settings: {
        defaultBudgets: () => Promise.resolve(e.settings.budgets),
        autonomy: () => Promise.resolve('standard'),
        subagents: () => Promise.resolve(e.settings.subagents),
        escalation: () => Promise.resolve('propose'),
      },
    });
    const v = await lone.create({
      accountId: ACCOUNT,
      objective: 'x',
      origin: 'user',
      authority: user(),
      start: true,
    });
    expect(v).toMatchObject({ status: 'paused', pauseReason: 'error' });
    await lone.close();
  });
});

describe('review breaker and shared status (FR-085, FR-215)', () => {
  it('the breaker pauses the run; resuming resets it', async () => {
    const resets: string[] = [];
    e.runs.useReviewReset((key) => resets.push(key));
    e.turns.script = async (t) => {
      await t.hold();
      return {};
    };
    const v = await create();
    await waitUntil(() => e.turns.isHeld(v.threadId));
    await e.runs.onReviewBreaker({ runId: null, threadId: v.threadId });
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'review_breaker',
      derived: { status: 'blocked', reason: 'Stopped by review' },
    });
    // Unknown runs and paused runs are left alone.
    await e.runs.onReviewBreaker({ runId: 'nope' });
    await e.runs.onReviewBreaker({});
    await e.runs.onReviewBreaker({ runId: v.id });
    e.turns.script = async () => ({ reply: 'ok' });
    await e.runs.resume(ACCOUNT, v.id);
    expect(resets).toEqual([v.id, v.threadId]);
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('done');
  });

  it('uses the shared status when bound, except for a plan waiting for Start', async () => {
    e.runs.useStatus(
      async (_a, ids) => new Map(ids.map((id) => [id, { status: 'running', reason: null }])),
    );
    const v = await create();
    await e.settle();
    expect((await e.runs.get(ACCOUNT, v.id)).derived).toEqual({ status: 'running', reason: null });
    const proposed = await create({ start: false });
    expect(proposed.derived).toEqual({ status: 'needs_input', reason: 'Waiting to start' });
    e.runs.useStatus(async () => {
      throw new Error('down');
    });
    expect((await e.runs.get(ACCOUNT, v.id)).derived.status).toBe('ready');
  });
});

describe('restart (FR-052)', () => {
  it('continues running runs from their last state; paused runs stay paused', async () => {
    e.turns.script = async () => ({ reply: 'ok' });
    const paused = await create({ title: 'paused' });
    await e.settle();
    e.env.db.raw
      .prepare(
        "UPDATE run SET status = 'paused', pause_reason = 'user', ended_at = NULL WHERE id = ?",
      )
      .run(paused.id);
    e.turns.script = async (t) => {
      t.step();
      await t.hold();
      return {};
    };
    const running = await create({ title: 'running' });
    await waitUntil(() => e.turns.isHeld(running.threadId));
    // The Hub stops: that turn never ends, and the loop's recovery marks it interrupted.
    e.env.db.raw
      .prepare(
        "UPDATE turn SET status = 'interrupted', stop_reason = 'error', ended_at = 'x' WHERE status = 'in_progress'",
      )
      .run();
    e.turns.running.clear();
    const turnsBefore = e.turns.started.length;
    e.turns.script = async () => ({ reply: 'resumed and done' });
    const runs = e.restart();
    expect(await runs.recover()).toBe(1);
    expect(e.turns.started.length).toBe(turnsBefore + 1);
    expect(e.turns.started.at(-1)).toMatchObject({
      threadId: running.threadId,
      text: expect.stringMatching(/^Continue the run/),
      authority: { kind: 'user', source: `run:${running.id}:restart` },
    });
    await e.settle();
    expect((await runs.get(ACCOUNT, running.id)).status).toBe('done');
    expect((await runs.get(ACCOUNT, paused.id)).status).toBe('paused');
  });
});

describe('activity (FR-057)', () => {
  it('merges the thread trace with run events, oldest first', async () => {
    const mk = (name: string, payload: Record<string, unknown>) =>
      makeEvent({ name, payload, correlation: { threadId: 't', runId: 'r' } });
    const events: EventEnvelope[] = [
      mk('run.created', { runId: 'r', objective: 'Do it' }),
      mk('turn.started', { turnId: 'u1' }),
      mk('run.plan.proposed', { runId: 'r', steps: ['a', 'b'] }),
      mk('run.step.started', { title: 'a' }),
      mk('tool.call.started', { callId: 'c1', tool: 'fs.read' }),
      mk('run.step.completed', { status: 'done', detail: 'ok' }),
      mk('run.status.changed', { from: 'running', to: 'paused', pauseReason: 'budget_time' }),
      mk('run.budget.reached', { bound: 'time', summary: 'Paused' }),
      mk('run.budget.extended', {}),
      mk('run.subagent.spawned', { role: 'researcher' }),
      mk('run.subagent.completed', { status: 'done' }),
      mk('goal.created', { objective: 'g' }),
      mk('goal.status.changed', { to: 'blocked', reason: 'no access' }),
      mk('run.plan.amended', { steps: ['a'], reason: 'edited' }),
      mk('run.completed', { status: 'output_missing', resultSummary: 'sum' }),
      mk('something.else', {}),
    ];
    const items = runActivity(events);
    expect(items.map((i) => i.title)).toEqual([
      'Run created',
      'Turn started',
      'Plan proposed (2 steps)',
      'Step started: a',
      'fs.read',
      'Step done',
      'Run paused',
      'Budget reached: time',
      'Budget extended',
      'Sub-agent started: researcher',
      'Sub-agent done',
      'Goal set',
      'Goal blocked',
      'Plan changed (1 steps)',
      'Run output missing',
    ]);
    expect(items[6]?.detail).toBe('reason: budget time');
  });
});

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}
