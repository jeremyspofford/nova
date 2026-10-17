// Sub-agents (FR-053, FR-054, docs/09 §4): child `work` threads under the run thread, depth 1,
// per-run and concurrency limits with a queue, usage counted toward the run, results through
// task.wait, and the parent's pause and cancel reaching the children.
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, makeRunsEnv, type FakeTurn, type RunsEnv } from './runs-env.ts';

let e: RunsEnv;

beforeEach(async () => {
  e = await makeRunsEnv();
  e.settings.subagents = { maxChildren: 3, maxConcurrent: 2 };
});

afterEach(async () => {
  await e.close();
});

const text = (r: { ok: boolean; content?: { type: string; text?: string }[] }) =>
  r.ok ? (r.content?.[0]?.text ?? '') : '';
const json = (r: Parameters<typeof text>[0]) => JSON.parse(text(r)) as Record<string, unknown>;

/** The parent's script runs in `parent`; children reply with their role and objective. */
function scripts(parent: (t: FakeTurn) => Promise<{ reply?: string } | undefined>) {
  const childGate = new Map<string, boolean>();
  e.turns.script = async (t) => {
    if (t.input.authorKind === 'subagent' || t.input.authorKind === 'user') {
      const kind = e.env.db.raw
        .prepare('SELECT 1 AS x FROM subagent WHERE thread_id = ?')
        .get(t.input.threadId);
      if (kind) {
        t.step({ tokens: 50 });
        if (childGate.get('hold')) await t.hold();
        return { reply: `found: ${t.input.text}` };
      }
    }
    return parent(t);
  };
  return childGate;
}

async function startRun() {
  return e.runs.create({
    accountId: ACCOUNT,
    objective: 'Compare three libraries',
    origin: 'user',
    authority: { kind: 'user', source: 'test' },
    start: true,
  });
}

describe('task.spawn and task.wait', () => {
  it('spawns children up to the limits, queues the rest and returns their results', async () => {
    const out: Record<string, unknown>[] = [];
    const gate = scripts(async (t) => {
      for (const lib of ['alpha', 'beta', 'gamma']) {
        const r = await t.call('task.spawn', { role: 'researcher', objective: `Assess ${lib}` });
        out.push(json(r));
      }
      const extra = await t.call('task.spawn', { role: 'critic', objective: 'one too many' });
      out.push({ refused: extra.ok ? null : extra.error.code });
      const list = json(await t.call('task.list'));
      out.push({ listed: (list.items as unknown[]).length });
      gate.set('hold', false);
      for (const id of ['x']) void id;
      const waited = json(
        await t.call('task.wait', { ids: out.slice(0, 3).map((o) => o.id), timeoutSeconds: 60 }),
      );
      out.push(waited);
      return { reply: 'Compared.' };
    });
    gate.set('hold', true);
    const v = await startRun();
    // Two run at once; the third waits in the queue.
    await waitUntil(() => out.length >= 5);
    expect(out.slice(0, 3).map((o) => o.status)).toEqual(['running', 'running', 'queued']);
    expect(out[3]).toEqual({ refused: 'limit' });
    expect(out[4]).toEqual({ listed: 3 });
    const subs = await e.runs.subagents(ACCOUNT, v.id);
    expect(subs.map((s) => s.status)).toEqual(['running', 'running', 'queued']);
    // Children are work threads under the run thread; their first turn has no authority.
    const child = e.env.db.raw
      .prepare('SELECT mode, parent_thread_id AS parent FROM thread WHERE id = ?')
      .get(subs[0]?.threadId ?? null) as { mode: string; parent: string };
    expect(child).toEqual({ mode: 'work', parent: v.threadId });
    expect(e.turns.started.find((s) => s.threadId === subs[0]!.threadId)).toMatchObject({
      text: 'Assess alpha',
      authorKind: 'subagent',
      runId: v.id,
      authority: { kind: 'none', origin: 'system' },
    });
    expect(await e.runs.status.children(ACCOUNT, v.threadId)).toHaveLength(2);
    // Release the running children: the queued one starts, then all finish.
    e.turns.release(subs[0]!.threadId!);
    e.turns.release(subs[1]!.threadId!);
    await e.settle();
    const waited = out[5]!;
    expect(waited.done).toBe(true);
    expect(waited.results).toEqual([
      expect.objectContaining({
        role: 'researcher',
        status: 'done',
        result: 'found: Assess alpha',
      }),
      expect.objectContaining({ status: 'done', result: 'found: Assess beta' }),
      expect.objectContaining({ status: 'done', result: 'found: Assess gamma' }),
    ]);
    const run = await e.runs.get(ACCOUNT, v.id);
    expect(run.status).toBe('done');
    // Children's usage counts toward the run (3 x 50 + the parent's 0 steps).
    expect(run.used.tokens).toBe(150);
    expect(e.env.events.names().filter((n) => n.startsWith('run.subagent'))).toEqual([
      'run.subagent.spawned',
      'run.subagent.spawned',
      'run.subagent.completed',
      'run.subagent.completed',
      'run.subagent.spawned',
      'run.subagent.completed',
    ]);
  });

  it('task.wait times out; the run then waits for its children and collects them', async () => {
    let result: Record<string, unknown> = {};
    const gate = scripts(async (t) => {
      if (t.input.text.startsWith('Your sub-agents have finished')) return { reply: 'Collected.' };
      const s = json(await t.call('task.spawn', { role: 'coder', objective: 'Slow task' }));
      const wait = t.call('task.wait', { ids: [s.id], timeoutSeconds: 5 });
      // The minimum is 10 s; the simulated clock moves past it.
      await new Promise((r) => setTimeout(r, 5));
      await e.clock.advance(9_000);
      await e.clock.advance(1_000);
      result = json(await wait);
      return { reply: 'gave up waiting' };
    });
    gate.set('hold', true);
    const v = await startRun();
    await waitUntil(() => Object.keys(result).length > 0);
    expect(result).toMatchObject({
      done: false,
      results: [expect.objectContaining({ status: 'running' })],
    });
    await waitUntil(() => e.turns.running.size === 1);
    // The parent's turn ended, but its child still works: the run stays live.
    expect((await e.runs.get(ACCOUNT, v.id)).status).toBe('running');
    const child = (await e.runs.subagents(ACCOUNT, v.id))[0]!;
    e.turns.release(child.threadId!);
    await e.settle();
    expect(e.turns.started.at(-1)).toMatchObject({
      threadId: v.threadId,
      authority: { kind: 'user', source: `run:${v.id}:children` },
    });
    const done = await e.runs.get(ACCOUNT, v.id);
    expect(done).toMatchObject({ status: 'done', result: { summary: 'Collected.' } });
  });

  it('children cannot spawn children (depth 1); tools outside a run refuse', async () => {
    const results: string[] = [];
    e.turns.script = async (t) => {
      if (t.input.authorKind === 'subagent') {
        const r = await t.call('task.spawn', { role: 'x', objective: 'nested' });
        results.push(r.ok ? 'ok' : r.error.code);
        const c = await t.call('run.complete', { summary: 'child result' });
        results.push(text(c));
        return { reply: 'ignored reply' };
      }
      const s = json(await t.call('task.spawn', { role: 'coder', objective: 'leaf' }));
      const bad = await t.call('task.spawn', {
        role: 'coder',
        objective: 'x',
        tools: ['task.spawn'],
      });
      results.push(bad.ok ? 'ok' : bad.error.code);
      const w = json(await t.call('task.wait', { ids: [s.id] }));
      results.push(JSON.stringify(w.results));
      const missing = await t.call('task.wait', { ids: ['nope'] });
      results.push(missing.ok ? 'ok' : missing.error.code);
      return { reply: 'done' };
    };
    await startRun();
    await e.settle();
    expect(results[0]).toBe('depth_limit');
    expect(results[1]).toMatch(/Result recorded/);
    expect(results[2]).toBe('invalid_arguments');
    expect(results[3]).toMatch(/"result":"child result"/);
    expect(results[4]).toBe('not_found');
  });

  it('a researcher limited to reading tools runs with the read-only profile', async () => {
    let childThread = '';
    e.turns.script = async (t) => {
      if (t.input.authorKind === 'subagent') {
        childThread = t.input.threadId;
        expect(t.addition?.context?.[0]).toMatchObject({ label: 'Sub-agent', trusted: true });
        return { reply: 'sources' };
      }
      await t.call('task.spawn', {
        role: 'researcher',
        objective: 'q1',
        tools: ['web.search', 'fs.read'],
      });
      await t.hold();
      return { reply: 'ok' };
    };
    const v = await startRun();
    await waitUntil(() => childThread !== '');
    expect(await e.runs.policy.forThread(ACCOUNT, childThread)).toMatchObject({
      approvalPolicy: 'defaults',
      profileId: 'read-only',
    });
    expect((await e.runs.toolsFor(ACCOUNT, childThread)).map((t) => t.descriptor.name)).toEqual([
      'run.complete',
    ]);
    const runTools = await e.runs.toolSource.list(ACCOUNT, { threadId: v.threadId, mode: 'work' });
    expect(runTools.map((t) => t.descriptor.name)).toEqual([
      'plan.set',
      'plan.update',
      'run.complete',
      'goal.get',
      'goal.set',
      'goal.update',
      'task.spawn',
      'task.message',
      'task.wait',
      'task.list',
      'task.cancel',
    ]);
    e.turns.release(v.threadId);
    await e.settle();
  });
});

describe("the parent's pause and cancel reach the children (FR-090)", () => {
  it('pausing queues running children; resuming starts them again', async () => {
    const gate = scripts(async (t) => {
      await t.call('task.spawn', { role: 'coder', objective: 'Part A' });
      await t.hold();
      return { reply: 'ok' };
    });
    gate.set('hold', true);
    const v = await startRun();
    await waitUntil(() => e.turns.running.size === 2);
    const child = (await e.runs.subagents(ACCOUNT, v.id))[0]!;
    await waitUntil(() => e.turns.isHeld(child.threadId!));
    await e.runs.pause(ACCOUNT, v.id);
    await e.settle();
    expect((await e.runs.subagents(ACCOUNT, v.id))[0]?.status).toBe('queued');
    gate.set('hold', false);
    e.turns.script = async (t) => {
      const sub = e.env.db.raw
        .prepare('SELECT 1 AS x FROM subagent WHERE thread_id = ?')
        .get(t.input.threadId);
      return { reply: sub ? 'child done' : 'parent done' };
    };
    await e.runs.resume(ACCOUNT, v.id);
    await e.settle();
    expect(
      e.turns.started.find(
        (s) => s.threadId === child.threadId && s.text === 'Continue your task.',
      ),
    ).toBeDefined();
    expect((await e.runs.subagents(ACCOUNT, v.id))[0]?.status).toBe('done');
  });

  it('cancelling the run cancels its children; task.cancel and task.message', async () => {
    const out: string[] = [];
    const gate = scripts(async (t) => {
      const a = json(await t.call('task.spawn', { role: 'coder', objective: 'A' }));
      const b = json(await t.call('task.spawn', { role: 'coder', objective: 'B' }));
      out.push(text(await t.call('task.cancel', { id: b.id })));
      out.push(text(await t.call('task.cancel', { id: b.id })));
      out.push(text(await t.call('task.message', { id: a.id, text: 'Also check C' })));
      const gone = await t.call('task.message', { id: b.id, text: 'x' });
      out.push(gone.ok ? 'ok' : gone.error.code);
      await t.hold();
      return {};
    });
    gate.set('hold', true);
    const v = await startRun();
    await waitUntil(() => out.length === 4);
    expect(out).toEqual([
      'Sub-agent cancelled.',
      'The sub-agent already ended (cancelled).',
      'Sent; the sub-agent reads it when its current turn ends.',
      'cancelled',
    ]);
    await e.runs.cancel(ACCOUNT, v.id);
    await e.settle();
    expect((await e.runs.subagents(ACCOUNT, v.id)).map((s) => s.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('a message to a finished child starts it again with the message', async () => {
    let second: Record<string, unknown> = {};
    scripts(async (t) => {
      const a = json(await t.call('task.spawn', { role: 'coder', objective: 'A' }));
      await t.call('task.wait', { ids: [a.id] });
      await t.call('task.message', { id: a.id, text: 'Now do B' });
      second = json(await t.call('task.wait', { ids: [a.id] }));
      return { reply: 'ok' };
    });
    await startRun();
    await e.settle();
    expect(second).toMatchObject({
      done: true,
      results: [expect.objectContaining({ result: 'found: Now do B' })],
    });
  });

  it("a child's budget stop pauses the whole run", async () => {
    e.settings.subagents = { maxChildren: 3, maxConcurrent: 2 };
    e.turns.script = async (t) => {
      if (t.input.authorKind === 'subagent') {
        for (let i = 0; i < 100; i++) if (!t.step({ tokens: 600 })) break;
        return {};
      }
      const s = json(await t.call('task.spawn', { role: 'coder', objective: 'Expensive' }));
      await t.call('task.wait', { ids: [s.id], timeoutSeconds: 3600 });
      return {};
    };
    const v = await e.runs.create({
      accountId: ACCOUNT,
      objective: 'x',
      origin: 'user',
      authority: { kind: 'user', source: 'test' },
      start: true,
      budgets: { tokens: 1000 },
    });
    await e.settle();
    expect(await e.runs.get(ACCOUNT, v.id)).toMatchObject({
      status: 'paused',
      pauseReason: 'budget_tokens',
      used: { tokens: 1200 },
    });
    expect((await e.runs.subagents(ACCOUNT, v.id))[0]?.status).toBe('queued');
  });

  it('a child that fails or is stopped by the user is reported', async () => {
    const results: unknown[] = [];
    e.turns.script = async (t) => {
      if (t.input.authorKind === 'subagent') {
        if (t.input.text === 'fail')
          return { stop: 'error', error: { code: 'x', message: 'it broke' } };
        await t.hold();
        return {};
      }
      const a = json(await t.call('task.spawn', { role: 'coder', objective: 'fail' }));
      const b = json(await t.call('task.spawn', { role: 'coder', objective: 'stop me' }));
      results.push(json(await t.call('task.wait', { ids: [a.id, b.id], timeoutSeconds: 3600 })));
      return { reply: 'ok' };
    };
    const v = await startRun();
    await waitUntil(() => e.turns.running.size === 2);
    const b = (await e.runs.subagents(ACCOUNT, v.id))[1]!;
    await waitUntil(() => e.turns.isHeld(b.threadId!));
    // The user presses Stop in the child's thread (FR-054).
    await e.turns.cancel(ACCOUNT, b.threadId!);
    await e.settle();
    expect(results[0]).toMatchObject({
      done: true,
      results: [
        expect.objectContaining({ status: 'failed', result: 'it broke' }),
        expect.objectContaining({ status: 'cancelled', result: 'stopped by the user' }),
      ],
    });
  });
});

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}
