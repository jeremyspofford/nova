/* eslint-disable @typescript-eslint/require-await */
// Agents in the real chat loop with the Mock provider and the real policy gate (docs/18 J7 steps
// 2, 4, 6): the agent's context reaches the model; a custom rule forces approval for messaging a
// channel (deny, then allow once) where an `act` rule let it through; proactive research is
// read-only at the gate; a safety pause refuses turns; a self-set wake lands in the scheduler and
// the user cancels it. The gate gets the agent's rules the way the Hub wires it: the policy set
// of an agent's thread includes `agents.agentPolicy.forThread` (the requested gate change).
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, type SettingKey } from '@nova/shared';
import {
  AgentService,
  PolicyGate,
  PolicyStore,
  ScheduleService,
  builtinDescriptor,
  ok,
  type AuditRecord,
  type BuiltinTool,
  type GateRequest,
  type NotificationInput,
  type ToolGate,
  type ToolSourceProvider,
  type TurnExtension,
} from '../src/index.ts';
import { ACCOUNT, waitFor } from './helpers.ts';
import { makeM5Env, turnRows, type M5Env } from './loop-m5-env.ts';

let env: M5Env;
let agents: AgentService;
let gate: PolicyGate;
let scheduler: ScheduleService;
let sent: Record<string, unknown>[];
let audit: AuditRecord[];
let notes: NotificationInput[];

const channelSend: BuiltinTool = {
  descriptor: builtinDescriptor({
    name: 'channel.send',
    title: 'Send to a channel',
    description: 'Post a message to a channel conversation',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        conversation: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['kind', 'conversation', 'text'],
    },
    annotations: { readOnly: false, action: 'send' },
    effects: ['external_communication'],
  }),
  origin: null,
  // The channels area's convention: an account resource `<kind>:<conversation>`.
  resource: (args) => {
    const a = args as { kind: string; conversation: string };
    return { kind: 'account', value: `${a.kind}:${a.conversation}` };
  },
  handler: async (args) => {
    sent.push(args as Record<string, unknown>);
    return ok('sent');
  },
};

beforeEach(async () => {
  sent = [];
  audit = [];
  notes = [];
  let agentsRef: AgentService | null = null;
  let gateRef: PolicyGate | null = null;
  const extension: TurnExtension = {
    forTurn: (input) => (agentsRef ? agentsRef.extension.forTurn(input) : Promise.resolve(null)),
  };
  const tools: ToolSourceProvider = {
    source: 'builtin',
    list: (accountId, scope) =>
      agentsRef ? agentsRef.toolSource.list(accountId, scope) : Promise.resolve([]),
  };
  const lazyGate: ToolGate = {
    check: (req, signal) => gateRef!.check(req, signal),
    preview: (req) => gateRef!.preview(req),
  };
  env = await makeM5Env({
    gate: lazyGate,
    extensions: [extension],
    builtins: [channelSend],
    sources: [tools],
  });
  // The agent's rules join the policy set of its threads (the wiring asked of the policy area).
  class AgentAwareStore extends PolicyStore {
    override async policySet(
      accountId: string,
      opts: { threadId?: string | null; home?: string | null } = {},
    ) {
      const set = await super.policySet(accountId, opts);
      const extra = opts.threadId
        ? await agentsRef!.agentPolicy.forThread(accountId, opts.threadId)
        : null;
      if (extra) {
        set.rules = [...(set.rules ?? []), ...extra.rules];
        set.commandRules = [...(set.commandRules ?? []), ...extra.commandRules];
      }
      return set;
    }
  }
  gate = new PolicyGate({
    store: new AgentAwareStore({ db: env.db }),
    events: env.events,
    audit: { append: async (r) => void audit.push(r) },
    notifier: { notify: async (n) => void notes.push(n) },
    setting: (key: SettingKey) => Promise.resolve(SETTINGS[key].default as never),
    dataDir: join(env.dir, 'data'),
    home: join(env.dir, 'home'),
    approvalTimeoutMs: () => 60_000,
  });
  gateRef = gate;
  agents = new AgentService({
    db: env.db,
    events: env.events,
    threads: env.threads,
    dataDir: join(env.dir, 'data'),
    settings: {
      defaultBudgets: async () => ({ timeSeconds: 600, tokens: 200_000, costUsd: null }),
      autonomy: async () => 'standard',
      proactive: async () => ({ enabledByDefault: true, intervalMinutes: 60 }),
      wakes: async () => ({ minMinutes: 5, horizonDays: 30, perDay: 24 }),
      reviewModel: async () => null,
    },
    audit: { append: async (r) => void audit.push(r) },
    notifier: { notify: async (n) => void notes.push(n) },
  });
  agentsRef = agents;
  gate.useThreadPolicy(agents.policy);
  agents.useTurns(env.chat.turnStarter);
  scheduler = new ScheduleService({
    db: env.db,
    events: env.events,
    secrets: env.secrets,
    audit: { append: async (r) => void audit.push(r as AuditRecord) },
  });
  agents.useScheduler(scheduler);
  scheduler.useAgents(agents.scheduleTarget);
});

afterEach(async () => {
  await scheduler.stop();
  await agents.close();
  await gate.close();
  await env.close();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await env.chat.idle();
    await agents.idle();
  }
}

function hasPending(): boolean {
  return (
    env.db.raw.prepare("SELECT 1 AS x FROM approval WHERE status = 'pending' LIMIT 1").get() !==
    undefined
  );
}

function pendingApproval(): string {
  const row = env.db.raw
    .prepare("SELECT id FROM approval WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  if (!row) throw new Error('no pending approval');
  return row.id;
}

const POST = '/tool channel.send {"kind":"slack","conversation":"#general","text":"Deploy done"}';

describe('agents in the chat loop', () => {
  it('gives the model the agent context and offers the agent tools', async () => {
    const a = await agents.create(ACCOUNT, {
      name: 'Ops',
      instructions: 'Keep replies short.',
      responsibilities: [{ title: 'Deploys' }],
    });
    await env.chat.send(ACCOUNT, a.primaryThreadId!, { text: 'status?' });
    await settle();
    const req = env.mock.requests.at(-1)!;
    const text = JSON.stringify(req.messages);
    expect(text).toContain('You are Ops, an always-on agent');
    expect(text).toContain('Keep replies short.');
    expect(text).toContain('Deploys');
    expect(req.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(['schedule.wake', 'agent.delegate', 'sessions.list', 'channel.send']),
    );
    expect(turnRows(env, a.primaryThreadId!)[0]).toMatchObject({
      status: 'completed',
      trigger: 'user',
    });
  });

  it('a custom rule forces approval for messaging a channel: deny, then allow once (J7 step 4)', async () => {
    const a = await agents.create(ACCOUNT, { name: 'Ops' });
    const t = a.primaryThreadId!;
    // A standing rule the user made names the channel: posting there needs no card.
    await agents.createRule(ACCOUNT, a.id, {
      description: 'Post deploy notes to #general',
      effect: 'act',
      match: { channels: [{ kind: 'slack', conversation: '#general' }] },
    });
    await env.chat.send(ACCOUNT, t, { text: POST });
    await settle();
    expect(sent).toHaveLength(1);
    // A rule that asks first wins over it for that channel.
    await agents.createRule(ACCOUNT, a.id, {
      description: 'Ask before posting in #general',
      effect: 'ask',
      priority: 10,
      match: { tools: ['channel.*'], channels: [{ kind: 'slack', conversation: '#general' }] },
    });
    await env.chat.send(ACCOUNT, t, { text: POST });
    await waitFor(hasPending);
    const card = await gate.decide(ACCOUNT, {
      approvalId: pendingApproval(),
      decision: 'deny_continue',
    });
    expect(card).toMatchObject({
      decision: 'deny_continue',
      reason: expect.stringContaining('Ask before posting in #general'),
    });
    await settle();
    expect(sent).toHaveLength(1);
    // The same call again is denied at once (repeat denial); a new message gets a new card.
    await env.chat.send(ACCOUNT, t, {
      text: '/tool channel.send {"kind":"slack","conversation":"#general","text":"Deploy 2 done"}',
    });
    await waitFor(hasPending);
    await gate.decide(ACCOUNT, { approvalId: pendingApproval(), decision: 'allow_once' });
    await settle();
    expect(sent).toHaveLength(2);
    // Another channel is not covered by either rule: a message to others is confirmed (FR-189).
    await env.chat.send(ACCOUNT, t, {
      text: '/tool channel.send {"kind":"slack","conversation":"#random","text":"hi"}',
    });
    await waitFor(hasPending);
    await gate.decide(ACCOUNT, { approvalId: pendingApproval(), decision: 'deny_continue' });
    await settle();
    expect(sent).toHaveLength(2);
  });

  it('proactive research reads only: the gate denies anything else on its thread (J7 step 2)', async () => {
    const a = await agents.create(ACCOUNT, { name: 'Ops' });
    expect(await agents.researchNow(ACCOUNT, a.id)).toEqual({ started: true, reason: null });
    await settle();
    const [s] = await agents.listSuggestions(ACCOUNT, a.id);
    expect(s?.body).toContain('Proactive research. You are idle');
    const research = (await agents.threadsOf(ACCOUNT, a.id)).find((x) => x.kind === 'proactive')!;
    const req: GateRequest = {
      accountId: ACCOUNT,
      threadId: research.threadId,
      turnId: '',
      callId: 'c1',
      projectId: null,
      mode: 'agent',
      tool: channelSend.descriptor,
      args: { kind: 'slack', conversation: '#general', text: 'x' },
      argsPreview: '{}',
      provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
      resource: { kind: 'account', value: 'slack:#general' },
      profile: { id: 'read-only', hash: 'x' },
    };
    const denied = await gate.check(req, new AbortController().signal);
    expect(denied).toMatchObject({ effect: 'deny' });
    expect(denied.reason).toContain('Proactive research only reads');
    // Reading is allowed there.
    const read = await gate.preview({
      ...req,
      tool: builtinDescriptor({
        name: 'agent.notes',
        title: 'n',
        description: 'n',
        inputSchema: { type: 'object' },
        annotations: { readOnly: true, action: 'read' },
      }),
    });
    expect(read.effect).toBe('allow');
  });

  it('a safety pause refuses turns; the user writing to a paused agent resumes it', async () => {
    const a = await agents.create(ACCOUNT, { name: 'Ops' });
    const t = a.primaryThreadId!;
    await agents.autoPause(ACCOUNT, a.id, 'repeated denials');
    await env.chat.send(ACCOUNT, t, { text: 'hello' });
    await settle();
    expect(turnRows(env, t).at(-1)).toMatchObject({ status: 'failed' });
    await agents.resume(ACCOUNT, a.id);
    await agents.pause(ACCOUNT, a.id);
    await env.chat.send(ACCOUNT, t, { text: 'carry on' });
    await settle();
    expect(turnRows(env, t).at(-1)).toMatchObject({ status: 'completed' });
    expect((await agents.get(ACCOUNT, a.id)).status).toBe('active');
  });

  it('sets its own wake, listed as set by the agent; the user cancels it (J7 step 6)', async () => {
    const a = await agents.create(ACCOUNT, { name: 'Ops' });
    await env.chat.send(ACCOUNT, a.primaryThreadId!, {
      text: '/tool schedule.wake {"in":"1h","reason":"check the deploy"}',
    });
    await settle();
    const [w] = await scheduler.list(ACCOUNT);
    expect(w).toMatchObject({
      origin: 'agent_self',
      agentId: a.id,
      wakeReason: 'check the deploy',
    });
    expect(env.events.names()).toContain('schedule.wake.set');
    await scheduler.remove(ACCOUNT, w!.id);
    expect(await scheduler.list(ACCOUNT)).toEqual([]);
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['schedule.wake', 'schedule.delete']),
    );
  });
});
