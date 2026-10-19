// Specialist/team agents (FR-091): provisioned by the owner with their own identity (an account
// that is nobody's and never signs in), scoped credentials bound to that identity, tasks from any
// person of the Hub run under the agent's identity on the real chat loop, the audit names the
// agent, and no person's memory reaches them.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentService,
  AuditLog,
  EgressStore,
  TeamAgentService,
  type ApprovalRequests,
  type AuditRecord,
} from '../src/index.ts';
import { ACCOUNT, waitFor } from './helpers.ts';
import { makeTeamEnv, systemText, type TeamEnv } from './team-env.ts';

let env: TeamEnv;
let agents: AgentService;
let teamAgents: TeamAgentService;
let egress: EgressStore;
const audit: AuditRecord[] = [];
const decided: { accountId: string; approvalId: string }[] = [];

const approvals: ApprovalRequests = {
  pending: (accountId) => Promise.resolve(accountId ? [] : []),
  get: () => Promise.reject(new Error('unused')),
  decide: (accountId, body) => {
    decided.push({ accountId, approvalId: body.approvalId });
    return Promise.resolve({ id: body.approvalId } as never);
  },
};

beforeEach(async () => {
  audit.length = 0;
  decided.length = 0;
  env = await makeTeamEnv();
  agents = new AgentService({
    db: env.db,
    events: env.events,
    threads: env.threads,
    dataDir: join(env.dir, 'data'),
    settings: {
      defaultBudgets: () => Promise.resolve({ timeSeconds: 1800, tokens: 500_000, costUsd: null }),
      autonomy: () => Promise.resolve('standard'),
      proactive: () => Promise.resolve({ enabledByDefault: false, intervalMinutes: 60 }),
      wakes: () => Promise.resolve({ minMinutes: 5, horizonDays: 30, perDay: 24 }),
      reviewModel: () => Promise.resolve(null),
    },
  });
  agents.useTurns(env.chat.turnStarter);
  env.chat.useExtension(agents.extension);
  egress = new EgressStore({ db: env.db, secrets: env.secrets });
  teamAgents = new TeamAgentService({
    db: env.db,
    events: env.events,
    team: env.team,
    agents,
    registry: env.registry,
    egress,
    auditLog: new AuditLog({ db: env.db }),
    audit: {
      append: async (r) => {
        audit.push(r);
        await new AuditLog({ db: env.db }).append(r);
      },
    },
  });
  teamAgents.useTurns(env.chat.turnStarter);
  teamAgents.useApprovals(approvals);
});

afterEach(async () => {
  await teamAgents.idle();
  await agents.close();
  await env.close();
});

describe('team agents (FR-091)', () => {
  it('are provisioned by the owner only, under an identity that is no person', async () => {
    const bea = await env.addMember('Bea');
    await expect(teamAgents.provision(bea, { name: 'Ops' })).rejects.toMatchObject({
      details: { reason: 'owner_only' },
    });
    const a = await teamAgents.provision(ACCOUNT, {
      name: 'Ops',
      instructions: 'Keep the wiki tidy',
    });
    expect(a.identityAccountId).not.toBe(ACCOUNT);
    expect(teamAgents.isIdentity(a.identityAccountId)).toBe(true);
    expect(teamAgents.identityOf(a.agentId)).toBe(a.identityAccountId);
    // Not a person: no role, not listed, never the owner, not invitable.
    expect(env.team.roleOf(a.identityAccountId)).toBeNull();
    expect(env.team.ownerId()).toBe(ACCOUNT);
    expect(env.team.members(ACCOUNT).map((m) => m.accountId)).toEqual([ACCOUNT, bea]);
    await expect(env.team.issueSession(a.identityAccountId)).rejects.toMatchObject({
      details: { reason: 'account_closed' },
    });
    // The agent lives in its identity's account, not the owner's.
    expect(await agents.list(ACCOUNT)).toEqual([]);
    expect((await agents.list(a.identityAccountId)).map((x) => x.name)).toEqual(['Ops']);
    expect((await teamAgents.list(bea)).map((x) => [x.name, x.credentials])).toEqual([['Ops', []]]);
    expect(audit.map((r) => [r.accountId, r.actor, r.action])).toEqual([
      [ACCOUNT, 'user', 'team_agent.provision'],
      [a.identityAccountId, `owner:${ACCOUNT}`, 'team_agent.provision'],
    ]);
  });

  it("run people's tasks under the agent's identity, with nobody's memory, audited as the agent", async () => {
    const bea = await env.addMember('Bea');
    await env.memory.create(ACCOUNT, { content: 'The owner paints with teal' });
    await env.memory.create(bea, { content: 'Bea keeps honey bees' });
    const a = await teamAgents.provision(ACCOUNT, { name: 'Ops' });
    const task = await teamAgents.createTask(bea, a.agentId, 'Summarize teal and bees');
    expect(task).toMatchObject({ status: 'running', requestedBy: bea });
    await env.chat.idle();
    await teamAgents.idle();
    const done = teamAgents.task(bea, task.id);
    expect(done.status).toBe('done');
    expect(done.result).toContain('Summarize teal and bees');
    const req = env.mock.requests.at(-1)!;
    expect(systemText(req)).not.toContain('teal');
    expect(systemText(req)).not.toContain('honey bees');
    // The turn ran in the identity's account.
    const started = env.envelopes.find(
      (e) => e.name === 'turn.started' && e.correlation?.turnId === done.turnId,
    );
    expect(started?.accountId).toBe(a.identityAccountId);
    const trail = await teamAgents.audit(ACCOUNT, a.agentId);
    const actions = trail.items.map((e) => [e.actor, e.action]);
    expect(actions).toContainEqual([`agent:${a.agentId}`, 'team_task.start']);
    expect(actions).toContainEqual([`agent:${a.agentId}`, 'team_task.end']);
    // Only the requester (and the owner) see the task.
    const cy = await env.addMember('Cy');
    expect(() => teamAgents.task(cy, task.id)).toThrow();
    expect(teamAgents.tasks(cy)).toEqual([]);
    expect(teamAgents.tasks(ACCOUNT, a.agentId).map((t) => t.id)).toEqual([task.id]);
    await expect(teamAgents.audit(bea, a.agentId)).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('bind scoped credentials to the identity and keep only references', async () => {
    const a = await teamAgents.provision(ACCOUNT, { name: 'Ops' });
    const p = await teamAgents.addCredential(ACCOUNT, a.agentId, {
      kind: 'provider',
      provider: 'openai',
      label: 'Ops key',
      // A public address (TEST-NET-3): an identity is not the owner, so its URL is checked.
      baseUrl: 'https://203.0.113.10/v1',
      apiKey: 'sk-very-secret',
    });
    expect(p.secretRef).toMatch(/^secret:\/\//);
    const providers = await env.registry.list(a.identityAccountId);
    expect(providers.map((x) => x.label)).toContain('Ops key');
    expect((await env.registry.list(ACCOUNT)).map((x) => x.label)).not.toContain('Ops key');
    const e = await teamAgents.addCredential(ACCOUNT, a.agentId, {
      kind: 'egress',
      label: 'Wiki token',
      hosts: ['wiki.example.com'],
      scheme: 'bearer',
      value: 'wiki-secret',
    });
    expect(e.secretRef).toMatch(/^secret:\/\/egress\//);
    const cred = egress.getCredential(a.identityAccountId, e.refId)!;
    expect(cred.scope).toEqual({ kind: 'agent', id: a.agentId });
    expect(
      egress.credentialIdsFor(a.identityAccountId, [{ kind: 'agent', id: 'another' }]),
    ).toEqual([]);
    expect(
      egress.credentialIdsFor(a.identityAccountId, [{ kind: 'agent', id: a.agentId }]),
    ).toEqual([e.refId]);
    const dump = JSON.stringify([
      env.db.raw.prepare('SELECT * FROM team_agent_credential').all(),
      env.db.raw.prepare('SELECT * FROM provider_account').all(),
      audit,
    ]);
    expect(dump).not.toContain('sk-very-secret');
    expect(dump).not.toContain('wiki-secret');
    expect((await teamAgents.get(ACCOUNT, a.agentId)).credentials.map((c) => c.kind)).toEqual([
      'provider',
      'egress',
    ]);
    const bea = await env.addMember('Bea');
    expect((await teamAgents.get(bea, a.agentId)).credentials).toEqual([]);
    await expect(
      teamAgents.addCredential(bea, a.agentId, {
        kind: 'egress',
        label: 'x',
        hosts: ['x.test'],
        scheme: 'bearer',
        value: 'v',
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await teamAgents.removeCredential(ACCOUNT, a.agentId, e.id);
    expect(egress.getCredential(a.identityAccountId, e.refId)).toBeNull();
    expect(await env.secrets.get(e.secretRef!)).toBeNull();
    await expect(teamAgents.removeCredential(ACCOUNT, a.agentId, e.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it("let the owner answer the identity's approvals, cancel tasks and remove the agent", async () => {
    const a = await teamAgents.provision(ACCOUNT, { name: 'Ops' });
    expect(await teamAgents.approvals(ACCOUNT, a.agentId)).toEqual([]);
    await teamAgents.decide(ACCOUNT, a.agentId, { approvalId: 'ap1', decision: 'deny' } as never);
    expect(decided).toEqual([{ accountId: a.identityAccountId, approvalId: 'ap1' }]);
    env.mock.requests.length = 0;
    const t = await teamAgents.createTask(ACCOUNT, a.agentId, 'a long job');
    const cancelled = await teamAgents.cancelTask(ACCOUNT, t.id);
    expect(['cancelled', 'done']).toContain(cancelled.status);
    await env.chat.idle();
    await teamAgents.remove(ACCOUNT, a.agentId);
    await expect(teamAgents.get(ACCOUNT, a.agentId)).rejects.toMatchObject({ code: 'not_found' });
    const row = env.db.raw
      .prepare('SELECT deleted_at FROM account WHERE id = ?')
      .get(a.identityAccountId) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
    await expect(teamAgents.createTask(ACCOUNT, a.agentId, 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('fails a task the loop cannot start', async () => {
    const a = await teamAgents.provision(ACCOUNT, { name: 'Ops' });
    const failing = new TeamAgentService({
      db: env.db,
      events: env.events,
      team: env.team,
      agents,
      registry: env.registry,
      egress,
    });
    await expect(failing.createTask(ACCOUNT, a.agentId, 'x')).rejects.toMatchObject({
      code: 'capability_missing',
    });
    failing.useTurns({
      startTurn: () => Promise.reject(new Error('loop down')),
      cancel: () => Promise.resolve(),
    });
    await expect(failing.createTask(ACCOUNT, a.agentId, 'x')).rejects.toThrow('loop down');
    await waitFor(() => failing.tasks(ACCOUNT).some((t) => t.status === 'failed'));
    expect(failing.tasks(ACCOUNT).find((t) => t.status === 'failed')?.error).toBe('loop down');
    expect(await failing.audit(ACCOUNT, a.agentId)).toEqual({ items: [], nextCursor: null });
    expect(await failing.approvals(ACCOUNT, a.agentId)).toEqual([]);
    await expect(
      failing.decide(ACCOUNT, a.agentId, { approvalId: 'x' } as never),
    ).rejects.toMatchObject({
      code: 'capability_missing',
    });
  });
});
