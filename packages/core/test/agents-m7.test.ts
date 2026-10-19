/* eslint-disable @typescript-eslint/require-await */
// Agent loop gaps closed in M7: a goal stopped by a provider usage limit tries again later, with a
// growing wait (FR-181, docs/09 §12); an agent's threads get `thread.status.changed` when the agent
// is paused or resumed and when its research or background threads change (FR-215); and plugins
// connected to an agent are the only plugins its threads may use (FR-045, docs/04 §2.5).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, makeEvent, uuidv7, type EventEnvelope } from '@nova/shared';
import { limitDenial } from '../src/approvals/index.ts';
import { MemoryEventSink } from '../src/events.ts';
import { ThreadStatusService } from '../src/requests/index.ts';
import { ACCOUNT, makeAgentsEnv, type AgentsEnv } from './agents-env.ts';
import { ensureTeamTables } from './team-env.ts';

let h: AgentsEnv;
beforeEach(async () => {
  h = await makeAgentsEnv({ usageRetryMs: async () => 60_000, usageRetryMaxMs: 150_000 });
});
afterEach(async () => {
  await h.close();
});

const goalTurns = () => h.turns.started.filter((s) => s.trigger === 'goal');

describe('goal retry after a usage limit (FR-181)', () => {
  it('waits, tries again with a doubling wait, and resets once a turn gets through', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    let limited = 2;
    h.turns.script = async (t) => {
      t.step();
      if (t.input.trigger === 'goal' && limited > 0) {
        limited--;
        return {
          stop: 'error',
          error: { code: 'rate_limited', message: 'provider limit reached' },
        };
      }
      return { reply: 'progress' };
    };
    const g = await h.agents.setGoal(ACCOUNT, a.id, { objective: 'Fix the flaky test' });
    await h.clock.advance(5_000, () => h.settle());
    expect(goalTurns()).toHaveLength(1);
    expect(await h.agents.getGoal(ACCOUNT, a.id)).toMatchObject({
      status: 'usage_limited',
      statusSetBy: 'system',
    });
    // Nothing before the wait is over.
    await h.clock.advance(59_000, () => h.settle());
    expect(goalTurns()).toHaveLength(1);
    await h.clock.advance(1_000, () => h.settle());
    expect(goalTurns()).toHaveLength(2);
    expect(await h.agents.getGoal(ACCOUNT, a.id)).toMatchObject({ status: 'usage_limited' });
    // The second wait is twice as long.
    await h.clock.advance(119_000, () => h.settle());
    expect(goalTurns()).toHaveLength(2);
    await h.clock.advance(1_000, () => h.settle());
    expect(goalTurns()).toHaveLength(3);
    expect((await h.agents.getGoal(ACCOUNT, a.id))?.status).toBe('active');
    expect(
      h.audit.filter((r) => r.action === 'goal.usage_retry').map((r) => r.detail),
    ).toMatchObject([
      { goalId: g.id, attempt: 1 },
      { goalId: g.id, attempt: 2 },
    ]);
  });

  it('stops retrying when the user takes over, and waits while the agent is paused', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    h.turns.script = async (t) => {
      t.step();
      return t.input.trigger === 'goal'
        ? { stop: 'error', error: { code: 'over_budget', message: 'out of credit' } }
        : { reply: 'ok' };
    };
    const g = await h.agents.setGoal(ACCOUNT, a.id, { objective: 'Keep CI green' });
    await h.clock.advance(5_000, () => h.settle());
    expect(goalTurns()).toHaveLength(1);
    // Paused: the retry looks again later instead of running.
    await h.agents.pause(ACCOUNT, a.id);
    await h.clock.advance(60_000, () => h.settle());
    expect(goalTurns()).toHaveLength(1);
    expect((await h.agents.getGoal(ACCOUNT, a.id))?.status).toBe('usage_limited');
    await h.agents.resume(ACCOUNT, a.id);
    await h.clock.advance(60_000, () => h.settle());
    expect(goalTurns()).toHaveLength(2);
    // The user clears the goal: no retry is left.
    await h.agents.clearGoal(ACCOUNT, a.id);
    await h.clock.advance(600_000, () => h.settle());
    expect(goalTurns()).toHaveLength(2);
    expect(h.audit.filter((r) => r.action === 'goal.usage_retry')).toMatchObject([
      { detail: { goalId: g.id, attempt: 1 } },
    ]);
  });

  it('re-arms waiting goals after a restart', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    await h.agents.setGoal(ACCOUNT, a.id, { objective: 'x' });
    h.env.db.raw
      .prepare(
        "UPDATE goal SET status = 'usage_limited', status_set_by = 'system' WHERE agent_id = ?",
      )
      .run(a.id);
    h.turns.script = async (t) => {
      t.step();
      return { reply: 'ok' };
    };
    h.agents.start();
    await h.settle();
    await h.clock.advance(60_000, () => h.settle());
    expect(goalTurns().length).toBeGreaterThanOrEqual(1);
    expect((await h.agents.getGoal(ACCOUNT, a.id))?.status).toBe('active');
  });
});

describe("thread.status.changed for an agent's threads (FR-215)", () => {
  it('follows a pause for safety, a resume, and the research thread under the main one', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const main = a.primaryThreadId!;
    // A research thread linked to the agent.
    const research = (await h.env.threads.create(ACCOUNT, { mode: 'agent', memoryOptOut: true }))
      .id;
    h.env.db.raw
      .prepare(
        "INSERT INTO agent_thread (thread_id, agent_id, account_id, kind, created_at) VALUES (?, ?, ?, 'proactive', ?)",
      )
      .run(research, a.id, ACCOUNT, new Date().toISOString());
    expect(await h.agents.statusLinks.parentsOf!(ACCOUNT, research)).toEqual([main]);
    expect(await h.agents.statusLinks.parentsOf!(ACCOUNT, main)).toEqual([]);
    expect(await h.agents.statusLinks.parentsOf!('someone-else', research)).toEqual([]);

    const bus = new EventBus();
    const sink = new MemoryEventSink();
    const status = new ThreadStatusService({ db: h.env.db, events: sink });
    status.useSources(h.agents.status);
    status.useLinks(h.agents.statusLinks);
    status.start(bus);
    const publish = (e: Parameters<typeof makeEvent>[0]) => bus.publish(makeEvent(e));
    const changes = () =>
      sink.events
        .filter((e) => e.name === 'thread.status.changed')
        .map((e) => [e.correlation?.threadId, e.payload.status]);

    await h.agents.pause(ACCOUNT, a.id, { reason: 'safety', detail: 'too many denials' });
    publish({
      name: 'agent.paused',
      actor: 'system',
      accountId: ACCOUNT,
      correlation: { agentId: a.id },
      payload: { agentId: a.id, reason: 'safety' },
    });
    await status.idle();
    expect(changes()).toEqual(
      expect.arrayContaining([
        [main, 'blocked'],
        [research, 'blocked'],
      ]),
    );
    await h.agents.resume(ACCOUNT, a.id);
    publish({
      name: 'agent.resumed',
      actor: 'user',
      accountId: ACCOUNT,
      correlation: { agentId: a.id },
      payload: { agentId: a.id },
    });
    await status.idle();
    expect(changes()).toEqual(expect.arrayContaining([[main, 'ready']]));

    // A turn in the research thread refreshes the main thread too.
    const turnId = uuidv7();
    const now = new Date().toISOString();
    h.env.db.raw
      .prepare(
        "INSERT INTO turn (id, thread_id, idx, status, trigger, execution_location, started_at, created_at, updated_at) VALUES (?, ?, 0, 'in_progress', 'event', 'hub', ?, ?, ?)",
      )
      .run(turnId, research, now, now, now);
    publish({
      name: 'turn.started',
      actor: 'system',
      accountId: ACCOUNT,
      correlation: { threadId: research, turnId },
      payload: {},
    });
    await status.idle();
    const last = changes()
      .filter(([id]) => id === main)
      .at(-1);
    expect(last).toEqual([main, 'running']);

    // Another account's agent event names no thread of this account.
    const foreign: EventEnvelope = makeEvent({
      name: 'agent.paused',
      actor: 'system',
      accountId: 'other',
      correlation: { agentId: a.id },
      payload: {},
    });
    expect(await h.agents.statusLinks.threadsOf!(foreign)).toEqual([]);
    expect(
      await h.agents.statusLinks.threadsOf!(
        makeEvent({
          name: 'turn.started',
          actor: 'system',
          accountId: ACCOUNT,
          payload: { agentId: a.id },
        }),
      ),
    ).toEqual([]);
    status.stop();
  });

  it('keeps going when a link fails', async () => {
    const bus = new EventBus();
    const sink = new MemoryEventSink();
    const status = new ThreadStatusService({ db: h.env.db, events: sink });
    status.useLinks({
      threadsOf: () => Promise.reject(new Error('down')),
      parentsOf: () => Promise.reject(new Error('down')),
    });
    status.start(bus);
    bus.publish(
      makeEvent({ name: 'agent.paused', actor: 'system', accountId: ACCOUNT, payload: {} }),
    );
    const t = (await h.env.threads.create(ACCOUNT, {})).id;
    bus.publish(
      makeEvent({
        name: 'turn.failed',
        actor: 'system',
        accountId: ACCOUNT,
        correlation: { threadId: t },
        payload: {},
      }),
    );
    await status.idle();
    expect(sink.events.filter((e) => e.name === 'thread.status.changed')).toEqual([]);
    status.stop();
  });
});

describe('plugins per agent (FR-045)', () => {
  it('connects installed plugins only, and limits the agent threads to them', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    // Without the table (before migration 0037) there is nothing to connect, and no limit.
    h.env.db.raw.exec('DROP TABLE IF EXISTS agent_plugin_scope');
    expect(await h.agents.toolLimits.forThread(ACCOUNT, a.primaryThreadId!)).toBeNull();
    await expect(h.agents.setPlugins(ACCOUNT, a.id, ['acme'])).rejects.toMatchObject({
      code: 'capability_missing',
    });
  });

  it('stores the list, validates it and narrows the gate', async () => {
    ensureTeamTables(h.env.db);
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const now = new Date().toISOString();
    h.env.db.raw
      .prepare(
        `INSERT INTO plugin_install (id, account_id, plugin_id, version, source, origin, manifest_json,
           install_path, registrations_json, installed_at, updated_at)
         VALUES (?, ?, 'acme', '1.0.0', 'local', '/x', '{}', '/x', '{}', ?, ?)`,
      )
      .run(uuidv7(), ACCOUNT, now, now);
    expect(await h.agents.plugins(ACCOUNT, a.id)).toBeNull();
    expect(await h.agents.toolLimits.forThread(ACCOUNT, a.primaryThreadId!)).toBeNull();
    await expect(h.agents.setPlugins(ACCOUNT, a.id, ['acme', 'ghost'])).rejects.toMatchObject({
      details: { reason: 'unknown_plugin', plugins: ['ghost'] },
    });
    expect(await h.agents.setPlugins(ACCOUNT, a.id, ['acme', 'acme'])).toEqual(['acme']);
    const limits = await h.agents.toolLimits.forThread(ACCOUNT, a.primaryThreadId!);
    expect(limits).toMatchObject({ plugins: ['acme'] });
    expect(limitDenial(limits!, { name: 'x', source: 'plugin' }, 'other')).toBe(
      'the plugin is not connected to this agent',
    );
    expect(limitDenial(limits!, { name: 'x', source: 'plugin' }, 'acme')).toBeNull();
    expect(await h.agents.toolLimits.forThread('other-account', a.primaryThreadId!)).toBeNull();
    expect(await h.agents.setPlugins(ACCOUNT, a.id, [])).toEqual([]);
    expect(await h.agents.plugins(ACCOUNT, a.id)).toEqual([]);
    expect(await h.agents.setPlugins(ACCOUNT, a.id, null)).toBeNull();
    expect(await h.agents.toolLimits.forThread(ACCOUNT, a.primaryThreadId!)).toBeNull();
    await expect(h.agents.plugins('other-account', a.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(h.audit.filter((r) => r.action === 'agent.plugins')).toHaveLength(3);
  });
});
