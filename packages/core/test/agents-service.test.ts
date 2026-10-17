/* eslint-disable @typescript-eslint/require-await */
// Agents (FR-079, FR-084, FR-089, FR-090, FR-080): create with responsibilities, an avatar and a
// main `agent` thread; edit; rules CRUD with audit and events; notes and conversation memory
// (forget, purge when memory is off, private or shared origin); suggestions; channel binding
// threads; the computer binding; delete with revocation hooks.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, eventNames, makeAgentsEnv, type AgentsEnv } from './agents-env.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let h: AgentsEnv;
beforeEach(async () => {
  h = await makeAgentsEnv();
});
afterEach(async () => {
  await h.close();
});

describe('agents', () => {
  it('creates an agent with defaults, responsibilities, an avatar and its main thread', async () => {
    const a = await h.agents.create(ACCOUNT, {
      name: '  Scout ',
      instructions: 'Watch the build.',
      avatar: { mime: 'image/png', data: PNG },
      responsibilities: [
        { title: 'CI health', instructions: 'Tell me when main is red' },
        { title: 'Docs' },
      ],
    });
    expect(a).toMatchObject({
      name: 'Scout',
      instructions: 'Watch the build.',
      status: 'active',
      autonomy: 'standard',
      hasAvatar: true,
      memoryEnabled: true,
      proactive: { enabled: true, lastRunAt: null },
      budgets: { timeSeconds: 1800, tokens: 500_000, costUsd: null },
      derived: { status: 'ready', reason: null },
      openSuggestions: 0,
      computerId: null,
    });
    expect(a.responsibilities.map((r) => [r.title, r.position])).toEqual([
      ['CI health', 0],
      ['Docs', 1],
    ]);
    const thread = h.env.db.raw
      .prepare('SELECT mode, title, memory_opt_out AS optOut FROM thread WHERE id = ?')
      .get(a.primaryThreadId) as { mode: string; title: string; optOut: number };
    expect(thread).toEqual({ mode: 'agent', title: 'Scout', optOut: 1 });
    expect(await h.agents.agentOfThread(ACCOUNT, a.primaryThreadId!)).toMatchObject({
      agentId: a.id,
      kind: 'main',
      audience: 'private',
    });
    expect(await h.agents.agentOfThread('someone-else', a.primaryThreadId!)).toBeNull();
    const img = await h.agents.avatar(ACCOUNT, a.id);
    expect(img?.mime).toBe('image/png');
    expect(eventNames(h.env, 'agent.')).toEqual(['agent.created']);
    expect(h.audit.find((r) => r.action === 'agent.create')).toMatchObject({
      kind: 'agent',
      actor: 'user',
      resource: `agent:${a.id}`,
    });
    expect((await h.agents.list(ACCOUNT)).map((x) => x.id)).toEqual([a.id]);
    expect(await h.agents.list('someone-else')).toEqual([]);
    await expect(h.agents.get('someone-else', a.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('needs a reviewer model for an autonomous agent (FR-085)', async () => {
    await expect(
      h.agents.create(ACCOUNT, { name: 'Auto', autonomy: 'autonomous' }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'review_model_required' } });
    h.settings.reviewModel = 'mock';
    expect(
      (await h.agents.create(ACCOUNT, { name: 'Auto', autonomy: 'autonomous' })).autonomy,
    ).toBe('autonomous');
  });

  it('edits the agent, renames its thread and replaces the avatar', async () => {
    const a = await h.agents.create(ACCOUNT, {
      name: 'Scout',
      avatar: { mime: 'image/png', data: PNG },
    });
    const blob = h.env.db.raw
      .prepare('SELECT avatar_path AS p FROM agent WHERE id = ?')
      .get(a.id) as {
      p: string;
    };
    const v = await h.agents.update(ACCOUNT, a.id, {
      name: 'Ranger',
      budgets: { tokens: 10_000, costUsd: 2 },
      proactive: false,
      avatar: null,
      model: 'mock:other',
    });
    expect(v).toMatchObject({
      name: 'Ranger',
      hasAvatar: false,
      proactive: { enabled: false },
      budgets: { timeSeconds: 1800, tokens: 10_000, costUsd: 2 },
      model: 'mock:other',
    });
    expect(existsSync(join(h.dataDir, blob.p))).toBe(false);
    const t = h.env.db.raw
      .prepare('SELECT title FROM thread WHERE id = ?')
      .get(a.primaryThreadId) as {
      title: string;
    };
    expect(t.title).toBe('Ranger');
    expect(h.env.events.events.find((e) => e.name === 'agent.updated')?.payload).toMatchObject({
      changed: ['name', 'budgets', 'proactive', 'model', 'avatar'],
    });
    await expect(h.agents.update(ACCOUNT, 'nope', { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('manages responsibilities separately', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const r = await h.agents.addResponsibility(ACCOUNT, a.id, {
      title: 'Inbox',
      instructions: ' triage ',
    });
    expect(r).toMatchObject({
      title: 'Inbox',
      instructions: 'triage',
      status: 'active',
      position: 0,
    });
    const u = await h.agents.updateResponsibility(ACCOUNT, a.id, r.id, {
      status: 'paused',
      instructions: null,
    });
    expect(u).toMatchObject({ status: 'paused', instructions: null });
    expect(await h.agents.listResponsibilities(ACCOUNT, a.id)).toHaveLength(1);
    await h.agents.removeResponsibility(ACCOUNT, a.id, r.id);
    expect(await h.agents.listResponsibilities(ACCOUNT, a.id)).toEqual([]);
    await expect(h.agents.removeResponsibility(ACCOUNT, a.id, r.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(
      h.audit.map((x) => x.action).filter((x) => x.startsWith('agent.responsibility')),
    ).toEqual([
      'agent.responsibility.create',
      'agent.responsibility.update',
      'agent.responsibility.delete',
    ]);
  });

  it('keeps rules editable, deletable and audited, and gives the gate thread-scoped rules', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const r = await h.agents.createRule(ACCOUNT, a.id, {
      description: 'Ask before posting in #general',
      effect: 'ask',
      match: { tools: ['channel.*'], channels: [{ kind: 'slack', conversation: '#general' }] },
    });
    expect(r).toMatchObject({ effect: 'ask', enabled: true, priority: 100, command: null });
    const cmd = await h.agents.createRule(ACCOUNT, a.id, {
      description: 'git reads',
      effect: 'act',
      command: {
        pattern: ['git', ['status', 'log']],
        matchExamples: ['git status'],
        notMatchExamples: ['git push'],
      },
    });
    await expect(
      h.agents.createRule(ACCOUNT, a.id, {
        description: 'bad',
        effect: 'handoff',
        command: { pattern: ['ls'], matchExamples: ['ls'], notMatchExamples: ['rm'] },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    const p = await h.agents.agentPolicy.forThread(ACCOUNT, a.primaryThreadId!);
    expect(p?.agentId).toBe(a.id);
    expect(p?.rules).toEqual([
      expect.objectContaining({
        id: r.id,
        effect: 'ask',
        scope: { kind: 'thread', ref: a.primaryThreadId },
        match: { tool: ['channel.*'], resource: { kind: 'account', pattern: 'slack:#general' } },
      }),
    ]);
    expect(p?.commandRules).toEqual([
      expect.objectContaining({
        id: `${cmd.id}:command`,
        decision: 'allow',
        scope: { kind: 'thread', ref: a.primaryThreadId },
      }),
    ]);
    const u = await h.agents.updateRule(ACCOUNT, a.id, r.id, {
      enabled: false,
      description: 'off',
    });
    expect(u).toMatchObject({ enabled: false, description: 'off' });
    expect((await h.agents.agentPolicy.forThread(ACCOUNT, a.primaryThreadId!))?.rules).toEqual([]);
    await h.agents.deleteRule(ACCOUNT, a.id, cmd.id);
    expect((await h.agents.listRules(ACCOUNT, a.id)).map((x) => x.id)).toEqual([r.id]);
    expect(await h.agents.agentPolicy.forThread(ACCOUNT, 'not-an-agent-thread')).toBeNull();
    expect(
      h.env.events.events
        .filter((e) => e.name === 'agent.rule.changed')
        .map((e) => e.payload.change),
    ).toEqual(['created', 'created', 'updated', 'deleted']);
    expect(h.audit.map((x) => x.action).filter((x) => x.startsWith('agent.rule'))).toEqual([
      'agent.rule.create',
      'agent.rule.create',
      'agent.rule.update',
      'agent.rule.delete',
    ]);
    // The preview lists recent calls the rule would have matched.
    const now = new Date().toISOString();
    h.env.db.raw
      .prepare(
        `INSERT INTO tool_call (id, account_id, thread_id, tool_name, source, args_json, status, created_at)
         VALUES ('c1', ?, ?, 'channel.send', 'builtin', ?, 'ok', ?),
                ('c2', ?, ?, 'fs.read', 'builtin', '{}', 'ok', ?)`,
      )
      .run(
        ACCOUNT,
        a.primaryThreadId,
        JSON.stringify({ kind: 'slack', to: '#general' }),
        now,
        ACCOUNT,
        a.primaryThreadId,
        now,
      );
    expect((await h.agents.previewRule(ACCOUNT, a.id, r.id)).map((x) => x.callId)).toEqual(['c1']);
  });

  it('keeps notes and conversation memory visible, editable and forgettable (FR-089)', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const n = await h.agents.addNote(ACCOUNT, a.id, {
      content: 'Prefers short answers',
      pinned: true,
    });
    expect(n).toMatchObject({
      store: 'notes',
      kind: 'note',
      author: 'user',
      pinned: true,
      originAudience: 'private',
    });
    // The user types a fact in the agent's thread: it becomes the agent's conversation memory.
    await (
      await h.turns.type(a.primaryThreadId!, 'My name is Robin. I live in Lisbon.')
    ).done;
    await h.settle();
    let items = await h.agents.listMemory(ACCOUNT, a.id);
    const conv = items.filter((i) => i.store === 'conversation');
    expect(conv.length).toBeGreaterThan(0);
    expect(conv[0]).toMatchObject({
      author: 'user',
      source: 'conversation',
      originAudience: 'private',
    });
    expect(await h.agents.memory.originOf(ACCOUNT, conv[0]!.id)).toBe('private');
    expect(await h.agents.memory.originOf(ACCOUNT, n.id)).toBe('private');
    expect(await h.agents.memory.originOf(ACCOUNT, 'nope')).toBeNull();
    // An agent-written note, through its tool.
    h.turns.script = async (t) => {
      t.step();
      const r = await t.call('agent.note', { content: 'Build breaks on Mondays', kind: 'fact' });
      return { reply: r.ok ? 'noted' : 'failed' };
    };
    await (
      await h.turns.type(a.primaryThreadId!, 'remember what you see')
    ).done;
    await h.settle();
    items = await h.agents.listMemory(ACCOUNT, a.id);
    const own = items.find((i) => i.author === 'agent');
    expect(own).toMatchObject({ kind: 'fact', source: 'tool', content: 'Build breaks on Mondays' });
    // Edit (the user rewrote it: now the user's words) and forget.
    const edited = await h.agents.updateMemory(ACCOUNT, a.id, own!.id, {
      content: 'Build breaks on Mondays (CI)',
    });
    expect(edited.author).toBe('user');
    const conv2 = await h.agents.updateMemory(ACCOUNT, a.id, conv[0]!.id, { pinned: true });
    expect(conv2).toMatchObject({ pinned: true, store: 'conversation' });
    await h.agents.deleteMemory(ACCOUNT, a.id, conv[0]!.id);
    await h.agents.deleteMemory(ACCOUNT, a.id, n.id);
    await expect(h.agents.deleteMemory(ACCOUNT, a.id, n.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(eventNames(h.env, 'agent.note.')).toEqual([
      'agent.note.created',
      'agent.note.created',
      'agent.note.updated',
      'agent.note.deleted',
    ]);
  });

  it('turning memory off purges what the agent derived and keeps the user notes', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    await h.agents.addNote(ACCOUNT, a.id, { content: 'User note' });
    h.turns.script = async (t) => {
      t.step();
      await t.call('agent.note', { content: 'Agent note' });
      return { reply: 'ok' };
    };
    await (
      await h.turns.type(a.primaryThreadId!, 'I prefer tea.')
    ).done;
    await h.settle();
    expect((await h.agents.listMemory(ACCOUNT, a.id)).length).toBeGreaterThanOrEqual(3);
    await h.agents.update(ACCOUNT, a.id, { memoryEnabled: false });
    const left = await h.agents.listMemory(ACCOUNT, a.id);
    expect(left.map((i) => i.content)).toEqual(['User note']);
    const purged = h.env.events.events.find((e) => e.name === 'agent.memory.purged');
    expect(purged?.payload).toMatchObject({ notes: 1 });
    // While off, the agent keeps no notes and nothing is remembered.
    await (
      await h.turns.type(a.primaryThreadId!, 'I prefer coffee.')
    ).done;
    await h.settle();
    expect((await h.agents.listMemory(ACCOUNT, a.id)).map((i) => i.content)).toEqual(['User note']);
  });

  it('gives each channel binding its own thread; a private one may share the main thread', async () => {
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const dm = await h.agents.threadFor(ACCOUNT, a.id, {
      bindingId: 'b-dm',
      audience: 'private',
      title: 'Slack DM',
    });
    expect(dm.created).toBe(true);
    expect(
      (await h.agents.threadFor(ACCOUNT, a.id, { bindingId: 'b-dm', audience: 'private' }))
        .threadId,
    ).toBe(dm.threadId);
    const shared = await h.agents.threadFor(ACCOUNT, a.id, {
      bindingId: 'b-ch',
      audience: 'shared',
      title: '#general',
    });
    expect(shared.threadId).not.toBe(dm.threadId);
    expect(await h.agents.agentOfThread(ACCOUNT, shared.threadId)).toMatchObject({
      kind: 'binding',
      audience: 'shared',
      bindingRef: 'b-ch',
    });
    const primary = await h.agents.threadFor(ACCOUNT, a.id, {
      bindingId: 'b-own',
      audience: 'private',
      sharePrimary: true,
    });
    expect(primary).toEqual({ threadId: a.primaryThreadId, created: false });
    expect((await h.agents.threadsOf(ACCOUNT, a.id)).map((t) => t.kind)).toEqual([
      'main',
      'binding',
      'binding',
    ]);
    // The channels area's resolver and wake thread, and the private notes its check reads.
    expect(
      await h.agents.bindingThread({
        accountId: ACCOUNT,
        agentId: a.id,
        binding: { id: 'b-ch', label: '#general', audience: 'shared', sharePrimaryThread: false },
      }),
    ).toBe(shared.threadId);
    await expect(
      h.agents.bindingThread({
        accountId: ACCOUNT,
        agentId: null,
        binding: { id: 'x', audience: 'shared', sharePrimaryThread: false },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(await h.agents.mainThreadOf(ACCOUNT, a.id)).toBe(a.primaryThreadId);
    const note = await h.agents.addNote(ACCOUNT, a.id, { content: 'Salary is 90k' });
    expect(await h.agents.memory.privateNotes(ACCOUNT, a.id)).toEqual([
      { id: note.id, text: 'Salary is 90k' },
    ]);
    expect(await h.agents.memory.privateNotes(ACCOUNT, null)).toHaveLength(1);
    // An agent-written note from a shared thread is shared; it stays out of private checks.
    h.turns.script = async (t) => {
      t.step();
      await t.call('agent.note', { content: 'Channel prefers bullet points' });
      return { reply: 'ok' };
    };
    await (
      await h.turns.startTurn({
        accountId: ACCOUNT,
        threadId: shared.threadId,
        text: 'from the channel',
        trigger: 'channel',
        authority: { kind: 'none', origin: 'channel' },
        authorKind: 'system',
      })
    ).done;
    await h.settle();
    const fromChannel = (await h.agents.listMemory(ACCOUNT, a.id)).find(
      (m) => m.author === 'agent',
    );
    expect(fromChannel?.originAudience).toBe('shared');
    expect(await h.agents.memory.originOf(ACCOUNT, fromChannel!.id)).toBe('shared');
    expect(await h.agents.memory.privateNotes(ACCOUNT, a.id)).toHaveLength(1);
    // A channel turn carries no authority of the user's (FR-189).
    expect(
      h.turns.turns.at(-1)?.addition?.context?.some((b) => b.label === 'Notes from the user'),
    ).toBe(false);
    await h.agents.releaseBinding(ACCOUNT, a.id, 'b-ch');
    expect(await h.agents.agentOfThread(ACCOUNT, shared.threadId)).toBeNull();
    expect(await h.agents.isActive(ACCOUNT, a.id)).toBe(true);
    expect(await h.agents.isActive(ACCOUNT, 'nope')).toBe(false);
  });

  it('binds the agent computer when the computers area is wired (FR-080)', async () => {
    const asked: string[] = [];
    h.agents.useComputers({
      forAgent: async (_accountId, agentId) => {
        asked.push(agentId);
        return { id: `computer-${agentId}` };
      },
    });
    const a = await h.agents.create(ACCOUNT, { name: 'Scout' });
    await h.settle();
    expect(asked).toEqual([a.id]);
    expect((await h.agents.get(ACCOUNT, a.id)).computerId).toBe(`computer-${a.id}`);
    // A provider that fails leaves the agent without one and tries again later.
    h.agents.useComputers({ forAgent: async () => Promise.reject(new Error('down')) });
    const b = await h.agents.create(ACCOUNT, { name: 'Other' });
    await h.settle();
    expect((await h.agents.get(ACCOUNT, b.id)).computerId).toBeNull();
  });

  it('deletes an agent with everything it holds, after the other areas revoked theirs', async () => {
    const a = await h.agents.create(ACCOUNT, {
      name: 'Scout',
      avatar: { mime: 'image/png', data: PNG },
    });
    await h.agents.addNote(ACCOUNT, a.id, { content: 'n' });
    await h.agents.createRule(ACCOUNT, a.id, { description: 'r', effect: 'ask', match: {} });
    await h.agents.setGoal(ACCOUNT, a.id, { objective: 'Keep CI green' });
    await h.agents.createSchedule(ACCOUNT, a.id, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'Morning check',
      deliveryTargets: [],
    });
    const bound = await h.agents.threadFor(ACCOUNT, a.id, { bindingId: 'b1', audience: 'shared' });
    const revoked: string[] = [];
    h.agents.onDelete(async (_accountId, agentId) => {
      revoked.push(agentId);
      if (revoked.length === 1) throw new Error('bindings area down');
    });
    // A failing revocation stops the delete before anything is removed.
    await expect(h.agents.remove(ACCOUNT, a.id)).rejects.toMatchObject({ code: 'server_error' });
    expect((await h.agents.get(ACCOUNT, a.id)).id).toBe(a.id);
    await h.agents.remove(ACCOUNT, a.id);
    expect(revoked).toEqual([a.id, a.id]);
    await expect(h.agents.get(ACCOUNT, a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.scheduler.listForAgent(ACCOUNT, a.id)).toEqual([]);
    const count = (sql: string) => (h.env.db.raw.prepare(sql).get(a.id) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM goal WHERE agent_id = ?')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM agent_memory WHERE agent_id = ?')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM agent_rule WHERE agent_id = ?')).toBe(0);
    const deleted = h.env.db.raw
      .prepare('SELECT COUNT(*) AS n FROM thread WHERE id IN (?, ?) AND deleted_at IS NOT NULL')
      .get(a.primaryThreadId, bound.threadId) as { n: number };
    expect(deleted.n).toBe(2);
    expect(h.audit.find((r) => r.action === 'agent.delete')).toMatchObject({
      detail: expect.objectContaining({ schedules: 1, threads: 2 }),
    });
    expect(eventNames(h.env, 'agent.deleted')).toHaveLength(1);
  });
});
