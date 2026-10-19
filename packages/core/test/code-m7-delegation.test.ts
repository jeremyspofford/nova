// Delegation from an agent to a Code session (docs/09 §4, M7): `code.delegate` starts a session
// in a project folder in Manual mode with the agent's budgets and no user authority; the gate
// applies the agent's rules in the session's thread; the result returns to the agent's main
// thread as data. Proactive and shared threads, other folders and empty projects are refused.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, uuidv7, type SettingKey, type ToolDescriptor } from '@nova/shared';
import type { CommandRule, PolicyRule } from '@nova/policy';
import { PolicyGate, PolicyStore } from '../src/approvals/index.ts';
import type { ToolContext } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { until } from './code-m6-env.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let e: CodeM7Env;
let gate: PolicyGate | null = null;
afterEach(async () => {
  await gate?.close();
  gate = null;
  await e.close();
});

const execTool: ToolDescriptor = {
  name: 'exec.run',
  title: 'Run',
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  annotations: { destructive: true },
  effects: ['exec'],
};

function project(folders: string[]): string {
  const id = uuidv7();
  const now = new Date().toISOString();
  e.db.raw
    .prepare(
      'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, ACCOUNT, 'proj', now, now);
  for (const path of folders)
    e.db.raw
      .prepare(
        'INSERT INTO project_folder (id, project_id, path, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(uuidv7(), id, path, 'write', now, now);
  return id;
}

describe('delegation from an agent', () => {
  it('starts a session under the agent, applies its rules and reports back', async () => {
    e = await makeCodeM7Env();
    const agentThread = (await e.threads.create(ACCOUNT, { mode: 'chat', title: 'agent' })).id;
    const links = new Map([[agentThread, { agentId: 'ag-1', kind: 'main', audience: 'private' }]]);
    e.delegations.useAgents({
      agentOf: (_a, t) => Promise.resolve(links.get(t) ?? null),
      mainThread: () => Promise.resolve(agentThread),
      budgets: () => Promise.resolve({ timeSeconds: 900, tokens: null, costUsd: 2 }),
    });
    const pid = project([e.repo]);
    const tool = e.delegations.tool();
    expect(tool.descriptor.annotations).toMatchObject({ action: 'execute' });
    const ctx = { accountId: ACCOUNT, threadId: agentThread } as unknown as ToolContext;
    const r = await tool.handler({ projectId: pid, objective: 'Fix the build' }, ctx);
    expect(r.ok).toBe(true);
    const sessionId = (r as { meta?: { sessionId?: string } }).meta?.sessionId ?? '';
    const s = e.svc.info(ACCOUNT, sessionId);
    expect(s).toMatchObject({ folder: e.repo, permissionMode: 'manual', projectId: pid });
    expect(e.svc.lineage(s.id).role).toBe('agent:ag-1');
    expect(e.svc.budget(ACCOUNT, s.id).limits).toEqual({
      timeSeconds: 900,
      tokens: null,
      costUsd: 2,
    });
    // The task is the agent's words: no user authority.
    expect(e.turns[0]).toMatchObject({
      threadId: s.threadId,
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'subagent',
    });
    expect(e.turns[0]!.text).toContain('Fix the build');
    expect(e.audit.find((a) => a.action === 'code.delegate')).toMatchObject({
      actor: 'agent:ag-1',
    });

    // The agent's rules apply in the session's thread, and only there.
    const deny: PolicyRule = {
      id: 'agent-no-exec',
      label: 'no commands',
      scope: { kind: 'thread', ref: agentThread },
      match: { tool: ['exec.run'] },
      effect: 'deny',
    };
    const agentRules = new Map<string, { rules: PolicyRule[]; commandRules: CommandRule[] }>([
      [agentThread, { rules: [deny], commandRules: [] }],
    ]);
    const settings: Partial<Record<SettingKey, unknown>> = {};
    mkdirSync(join(e.dir, 'gate-data', 'workspace'), { recursive: true });
    gate = new PolicyGate({
      store: new PolicyStore({ db: e.db }),
      events: e.events,
      audit: { append: () => Promise.resolve() },
      notifier: { notify: () => Promise.resolve() },
      setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
      dataDir: join(e.dir, 'gate-data'),
      home: e.home,
    });
    gate.useAgentPolicy(
      e.delegations.delegatedRules({
        forThread: (_a, t) => Promise.resolve(agentRules.get(t) ?? null),
      }),
    );
    const other = await e.svc.create(ACCOUNT, { folder: e.repo });
    const preview = (threadId: string) =>
      gate!.preview({
        accountId: ACCOUNT,
        threadId,
        projectId: null,
        mode: 'code',
        tool: execTool,
        args: { cmd: 'npm test' },
        provenance: { taint: ['tool'] },
        profile: { id: 'workspace', hash: 'h' },
      });
    expect((await preview(s.threadId)).effect).toBe('deny');
    expect((await preview(other.threadId)).effect).not.toBe('deny');
    // A delegation whose agent's rules are gone denies everything (fail closed).
    const kept = agentRules.get(agentThread)!;
    agentRules.clear();
    expect((await preview(s.threadId)).effect).toBe('deny');
    agentRules.set(agentThread, kept);

    // The session's turn ends: its reply returns to the agent as data.
    e.finishTurn(0, { replyText: 'Fixed the import.' });
    await until(() => e.turns.length === 2);
    expect(e.turns[1]).toMatchObject({
      threadId: agentThread,
      trigger: 'event',
      authority: { kind: 'none', origin: 'tool' },
    });
    expect(e.turns[1]!.text).toContain('Fixed the import.');
    await until(() => e.delegations.list(ACCOUNT, 'ag-1')[0]?.status === 'done');
    expect(e.events.events.some((x) => x.name === 'code.delegation.completed')).toBe(true);

    // Refusals.
    const refuse = async (args: Record<string, unknown>, threadId = agentThread) => {
      const out = await tool.handler(args, { ...ctx, threadId });
      return out.ok ? 'ok' : out.error.code;
    };
    links.set('proactive', { agentId: 'ag-1', kind: 'proactive', audience: 'private' });
    links.set('shared', { agentId: 'ag-1', kind: 'binding', audience: 'shared' });
    expect(await refuse({ projectId: pid, objective: 'x' }, 'proactive')).toBe(
      'proactive_read_only',
    );
    expect(await refuse({ projectId: pid, objective: 'x' }, 'shared')).toBe('shared_thread');
    expect(await refuse({ projectId: pid, objective: 'x' }, 'nobody')).toBe('not_an_agent_thread');
    const elsewhere = join(e.home, 'elsewhere');
    mkdirSync(elsewhere);
    expect(await refuse({ projectId: pid, objective: 'x', folder: elsewhere })).toBe(
      'outside_project',
    );
    expect(await refuse({ projectId: project([]), objective: 'x' })).toBe('no_project_folder');
  });
  it('keeps the agent limits in workers, applies its plugins, and holds or cancels on pause or delete', async () => {
    e = await makeCodeM7Env();
    const agentThread = (await e.threads.create(ACCOUNT, { mode: 'chat', title: 'agent' })).id;
    let active = true;
    e.delegations.useAgents({
      agentOf: (_a, t) =>
        Promise.resolve(
          t === agentThread ? { agentId: 'ag-2', kind: 'main', audience: 'private' } : null,
        ),
      mainThread: () => Promise.resolve(agentThread),
      budgets: () => Promise.resolve({ timeSeconds: 900, tokens: null, costUsd: 2 }),
      isActive: () => Promise.resolve(active),
    });
    const pid = project([e.repo]);
    const ctx = { accountId: ACCOUNT, threadId: agentThread } as unknown as ToolContext;
    const r = await e.delegations.tool().handler({ projectId: pid, objective: 'Fix it' }, ctx);
    const s = e.svc.info(ACCOUNT, String(r.ok ? r.meta?.sessionId : ''));
    const deny: PolicyRule = {
      id: 'agent-no-exec',
      scope: { kind: 'thread', ref: agentThread },
      match: { tool: ['exec.run'] },
      effect: 'deny',
    };
    const agentRules = new Map<string, { rules: PolicyRule[]; commandRules: CommandRule[] }>([
      [agentThread, { rules: [deny], commandRules: [] }],
    ]);
    mkdirSync(join(e.dir, 'gate-data', 'workspace'), { recursive: true });
    gate = new PolicyGate({
      store: new PolicyStore({ db: e.db }),
      events: e.events,
      audit: { append: () => Promise.resolve() },
      notifier: { notify: () => Promise.resolve() },
      setting: (key) => Promise.resolve(SETTINGS[key].default as never),
      dataDir: join(e.dir, 'gate-data'),
      home: e.home,
    });
    gate.useAgentPolicy(
      e.delegations.delegatedRules({
        forThread: (_a, t) => Promise.resolve(agentRules.get(t) ?? null),
      }),
    );
    // The agent's plugins: only `plugin.ok` may run in its threads (and so in its work).
    gate.useToolLimits(
      e.delegations.delegatedToolLimits({
        forThread: (_a, t) =>
          Promise.resolve(
            t === agentThread
              ? { plugins: ['plugin.ok'], reason: 'not connected to this agent' }
              : null,
          ),
      }),
    );
    const preview = (threadId: string, tool: ToolDescriptor = execTool) =>
      gate!.preview({
        accountId: ACCOUNT,
        threadId,
        projectId: null,
        mode: 'code',
        tool,
        args: { cmd: 'npm test' },
        provenance: { taint: ['tool'] },
        profile: { id: 'workspace', hash: 'h' },
      });
    // The delegated session starts a worker (task.spawn): the agent's rules and budgets follow.
    e.finishTurn(0, { replyText: 'ok' });
    const w = await e.ops.spawnWorker(ACCOUNT, s.threadId, { role: 'coder', objective: 'run' });
    expect((await preview(s.threadId)).effect).toBe('deny');
    expect((await preview(w.threadId)).effect).toBe('deny');
    expect(e.svc.budget(ACCOUNT, w.sessionId).limits).toEqual({
      timeSeconds: 900,
      tokens: null,
      costUsd: 2,
    });
    const pluginTool = (pluginId: string): ToolDescriptor => ({
      name: `${pluginId}.do`,
      title: 'do',
      description: '',
      source: 'plugin',
      pluginId,
      inputSchema: { type: 'object' },
      annotations: { readOnly: true },
    });
    expect((await preview(w.threadId, pluginTool('plugin.other'))).effect).toBe('deny');
    expect((await preview(w.threadId, pluginTool('plugin.ok'))).effect).not.toBe('deny');
    const readTool: ToolDescriptor = {
      ...execTool,
      name: 'fs.read',
      annotations: { readOnly: true },
      effects: [],
    };
    expect((await preview(w.threadId, readTool)).effect).not.toBe('deny');

    // Paused: the running turns stop and every action is held until the agent resumes.
    const cancels: string[] = [];
    const turns = e.svc.turns!;
    e.svc.useTurns({
      startTurn: (i) => turns.startTurn(i),
      cancel: (_a, t) => Promise.resolve(void cancels.push(t)),
    });
    e.db.raw.prepare("UPDATE thread SET state = 'streaming' WHERE id = ?").run(w.threadId);
    active = false;
    await e.delegations.agentChanged(ACCOUNT, 'ag-2', 'paused');
    expect(cancels).toContain(w.threadId);
    expect((await preview(w.threadId, readTool)).effect).toBe('deny');
    expect(e.audit.some((a) => a.action === 'code.delegation.held')).toBe(true);
    active = true;
    await e.delegations.agentChanged(ACCOUNT, 'ag-2', 'active');
    expect((await preview(w.threadId, readTool)).effect).not.toBe('deny');
    // Even with no event (a restart), the agents area's answer holds the work.
    active = false;
    expect((await preview(s.threadId, readTool)).effect).toBe('deny');
    active = true;

    // Deleted: the work is cancelled, archived, and its rules deny whatever is left.
    const second = await e.delegations.tool().handler({ projectId: pid, objective: 'More' }, ctx);
    expect(second.ok).toBe(true);
    agentRules.clear();
    await e.delegations.agentChanged(ACCOUNT, 'ag-2', 'deleted');
    expect(e.svc.info(ACCOUNT, s.id).active).toBe(false);
    expect(e.svc.info(ACCOUNT, w.sessionId).active).toBe(false);
    // It had reported back already: it stays done; its session and worker are archived.
    const rows = e.delegations.list(ACCOUNT, 'ag-2');
    expect(rows.map((x) => x.status).sort()).toEqual(['done', 'failed']);
    expect((await preview(w.threadId, readTool)).effect).toBe('deny');
    expect(e.audit.some((a) => a.action === 'code.delegation.cancelled')).toBe(true);
  });
});
