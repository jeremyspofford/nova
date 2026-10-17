// The policy gate (FR-099, FR-100, FR-189): each decision path of an approval, grants, the
// timeout, cancel, repeat deny, handoff and the answer race.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, type SettingKey, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  commandOf,
  type AuditRecord,
  type GateOutcome,
  type GateRequest,
  type NotificationInput,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
const THREAD2 = '01920000-0000-7000-8000-0000000000a2';

const tool = (over: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor => ({
  title: over.name,
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  ...over,
});
const execTool = tool({
  name: 'exec.run',
  title: 'Run command',
  annotations: { destructive: true },
  effects: ['exec'],
});
const readTool = tool({ name: 'fs.read', title: 'Read file', annotations: { readOnly: true } });
const writeTool = tool({
  name: 'fs.write',
  title: 'Write file',
  annotations: { destructive: true },
  effects: ['file_write'],
});
const postTool = tool({
  name: 'web.post',
  annotations: { requiresNetwork: true },
  effects: ['network'],
});
const purchase = tool({ name: 'mcp:shop.purchase_item', source: 'mcp', serverId: 'shop' });
const captcha = tool({ name: 'browser.captcha', effects: ['captcha'] });

let dir: string;
let db: NovaDatabase;
let store: PolicyStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let notes: NotificationInput[];
let settings: Partial<Record<SettingKey, unknown>>;
let clock: { now: number };
let timeoutMs: number;
let gate: PolicyGate;

function makeGate(extra: Partial<ConstructorParameters<typeof PolicyGate>[0]> = {}): PolicyGate {
  return new PolicyGate({
    store,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => timeoutMs,
    now: () => new Date(clock.now),
    ...extra,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-gate-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  for (const id of [THREAD, THREAD2])
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'chat', 'streaming', ?, ?)",
      )
      .run(id, ACCOUNT, now, now);
  clock = { now: Date.now() };
  store = new PolicyStore({ db, now: () => new Date(clock.now) });
  events = new MemoryEventSink();
  audit = [];
  notes = [];
  settings = {};
  timeoutMs = 60_000;
  gate = makeGate();
});

afterEach(async () => {
  await gate.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let calls = 0;
function req(over: Partial<GateRequest> = {}): GateRequest {
  calls++;
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: `call-${calls}`,
    projectId: null,
    mode: 'chat',
    tool: execTool,
    args: { cmd: 'npm test' },
    argsPreview: '{"cmd":"npm test"}',
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
    ...over,
  };
}

/** Start a check and wait for the approval it creates. */
async function asking(r: GateRequest, signal = new AbortController().signal) {
  const before = events.events.filter((e) => e.name === 'approval.requested').length;
  const outcome = gate.check(r, signal);
  let approvalId = '';
  await vi.waitFor(() => {
    const reqs = events.events.filter((e) => e.name === 'approval.requested');
    expect(reqs.length).toBe(before + 1);
    approvalId = reqs.at(-1)!.payload.approvalId as string;
  });
  return { outcome, approvalId };
}

const threadState = (id = THREAD) =>
  (db.raw.prepare('SELECT state FROM thread WHERE id = ?').get(id) as { state: string }).state;

describe('allow and deny without asking', () => {
  it('allows a read-only call, audits it by hash and emits policy.tier', async () => {
    const out = await gate.check(
      req({
        tool: readTool,
        args: { path: 'notes.md', secret: 'hunter2' },
        resource: { kind: 'path', value: 'notes.md' },
      }),
      new AbortController().signal,
    );
    expect(out).toMatchObject({ effect: 'allow', tier: 'pre_approvable' });
    expect(audit[0]).toMatchObject({ kind: 'policy', action: 'fs.read', decision: 'allow' });
    expect(audit[0]!.inputHash).toMatch(/^sha256:/);
    expect(JSON.stringify(audit)).not.toContain('hunter2');
    expect(audit[0]!.resource).toBe(join(dir, 'data', 'workspace', 'notes.md'));
    const tier = events.events.find((e) => e.name === 'policy.tier')!;
    expect(tier.payload).toMatchObject({
      action: 'fs.read',
      tier: 'pre_approvable',
      authorization: 'user_typed',
    });
    expect(tier.correlation).toMatchObject({ threadId: THREAD, turnId: 'turn-1' });
  });

  it('denies by rule, emits policy.denied and never creates an approval', async () => {
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'exec.run' },
      effect: 'deny',
      label: 'No exec',
    });
    const out = await gate.check(req(), new AbortController().signal);
    expect(out).toMatchObject({ effect: 'deny', stop: false, reason: 'rule "No exec"' });
    expect(events.names()).toContain('policy.denied');
    expect(await store.listApprovals(ACCOUNT, { status: 'all' })).toEqual([]);
  });

  it('denies paths outside the roots and symlinks that escape them', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.txt'), 'x');
    symlinkSync(outside, join(dir, 'data', 'workspace', 'link'));
    const at = (value: string, t = writeTool) =>
      gate.check(
        req({ tool: t, args: { path: value }, resource: { kind: 'path', value } }),
        new AbortController().signal,
      );
    expect((await at('link/x.txt', readTool)).effect).toBe('deny');
    expect((await at('../outside/x.txt', readTool)).effect).toBe('deny');
    expect((await at(join(dir, 'data', 'nova.db'), readTool)).effect).toBe('deny');
    expect((await at('.git/config')).reason).toBe('.git stays read-only');
    expect((await at('sub/../.git/config')).effect).toBe('deny');
  });

  it('refuses the full profile without a VM or container, and allows it inside one', async () => {
    expect(
      (
        await gate.check(
          req({ tool: readTool, profile: { id: 'full', hash: 'h' } }),
          new AbortController().signal,
        )
      ).effect,
    ).toBe('deny');
    gate.useSubstrate(() => 'container');
    expect(
      (
        await gate.check(
          req({ tool: readTool, profile: { id: 'full', hash: 'h' } }),
          new AbortController().signal,
        )
      ).effect,
    ).toBe('allow');
  });

  it('falls back to read-only for an unknown profile', async () => {
    const out = await gate.check(
      req({
        tool: writeTool,
        args: {},
        resource: { kind: 'path', value: 'a.txt' },
        profile: { id: 'nope', hash: 'h' },
      }),
      new AbortController().signal,
    );
    expect(out).toMatchObject({ effect: 'deny', reason: 'this folder is read-only for tools' });
  });

  it('uses per-server defaults wired from the MCP area', async () => {
    const mcpRead = tool({ name: 'mcp:files.list_things', source: 'mcp', serverId: 'files' });
    gate.useServerDefaults((_a, server) => Promise.resolve(server === 'files' ? 'allow' : null));
    expect(
      (await gate.check(req({ tool: mcpRead, args: {} }), new AbortController().signal)).effect,
    ).toBe('allow');
  });

  it('returns at once when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await gate.check(req(), ac.signal)).toMatchObject({ effect: 'deny', stop: true });
  });
});

describe('approvals (FR-100)', () => {
  it('creates an approval card, notifies, marks the thread waiting and resolves allow_once', async () => {
    const { outcome, approvalId } = await asking(req());
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view).toMatchObject({
      status: 'pending',
      tool: 'exec.run',
      action: 'Run `npm test`',
      tier: 'pre_approvable',
      userAsked: true,
      risk: 'medium',
      options: [
        'allow_once',
        'allow_session',
        'allow_always',
        'deny_continue',
        'deny_stop',
        'handoff',
      ],
    });
    expect(view.alwaysScopes.map((s) => s.kind)).toEqual(['tool', 'prefix_rule']);
    expect(view).toMatchObject({ ruleId: null, ruleLabel: null, alwaysAllowManaged: false });
    expect(view.alwaysScopes[1]).toMatchObject({
      rule: {
        pattern: ['npm', 'test'],
        matchExamples: ['npm test'],
        notMatchExamples: ['npm install'],
      },
    });
    expect(threadState()).toBe('waiting_approval');
    expect(notes[0]).toMatchObject({
      kind: 'approval',
      href: `/chat/${THREAD}?approval=${approvalId}`,
    });
    const requested = events.events.find((e) => e.name === 'approval.requested')!;
    expect(requested.correlation).toMatchObject({ threadId: THREAD, turnId: 'turn-1' });
    expect(requested.payload).toMatchObject({
      tier: 'pre_approvable',
      risk: 'medium',
      scope: `thread:${THREAD}`,
    });
    const decided = await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    expect(decided).toMatchObject({ status: 'decided', decision: 'allow_once', decidedBy: 'user' });
    expect(await outcome).toMatchObject({ effect: 'allow', approvalId });
    expect(threadState()).toBe('streaming');
    expect(events.events.find((e) => e.name === 'approval.decided')!.payload).toMatchObject({
      approvalId,
      decision: 'allow_once',
      decidedBy: 'user',
      override: false,
    });
    expect(audit.map((a) => `${a.kind}:${a.action}`)).toEqual([
      'policy:exec.run',
      'approval:approval.requested',
      'approval:approval.decided',
    ]);
    // Allow once: the next identical call asks again.
    const again = await asking(req());
    await gate.decide(ACCOUNT, { approvalId: again.approvalId, decision: 'deny_stop' });
    expect(await again.outcome).toMatchObject({ effect: 'deny', stop: true });
  });

  it('allow_session grants the command prefix for this chat only', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_session' });
    expect(await outcome).toMatchObject({ effect: 'allow' });
    expect(await store.listGrants(ACCOUNT)).toMatchObject([
      { duration: 'session', tool: 'exec.run', scopeKind: 'session', scopeRef: THREAD },
    ]);
    expect(
      (
        await gate.check(
          req({ args: { cmd: 'npm test -- --watch' } }),
          new AbortController().signal,
        )
      ).effect,
    ).toBe('allow');
    const other = await asking(req({ threadId: THREAD2 }));
    await gate.decide(ACCOUNT, { approvalId: other.approvalId, decision: 'deny_continue' });
    expect((await other.outcome).effect).toBe('deny');
  });

  it('allow_session for a command without a safe prefix covers only the identical call', async () => {
    const r = req({ args: { cmd: 'echo $(date)' } });
    const { outcome, approvalId } = await asking(r);
    expect((await store.getApproval(ACCOUNT, approvalId)).alwaysScopes.map((s) => s.kind)).toEqual([
      'tool',
    ]);
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_session' });
    await outcome;
    expect(
      (await gate.check(req({ args: { cmd: 'echo $(date)' } }), new AbortController().signal))
        .effect,
    ).toBe('allow');
    const different = await asking(req({ args: { cmd: 'echo $(id)' } }));
    await gate.decide(ACCOUNT, { approvalId: different.approvalId, decision: 'allow_once' });
    await different.outcome;
  });

  it('allow_always on the tool writes a rule and a grant; revoking removes both', async () => {
    const { outcome, approvalId } = await asking(
      req({ tool: writeTool, args: { path: 'a.md' }, resource: { kind: 'path', value: 'a.md' } }),
    );
    await gate.decide(ACCOUNT, {
      approvalId,
      decision: 'allow_always',
      alwaysScope: { kind: 'tool', tool: 'fs.write' },
    });
    expect((await outcome).effect).toBe('allow');
    const rules = await store.listRules(ACCOUNT);
    expect(rules).toMatchObject([
      { effect: 'allow', match: { tool: 'fs.write' }, scopeKind: 'global', source: 'user' },
    ]);
    const grants = await store.listGrants(ACCOUNT);
    expect(grants).toMatchObject([{ duration: 'always', tool: 'fs.write' }]);
    expect(
      (
        await gate.check(
          req({
            threadId: THREAD2,
            tool: writeTool,
            args: { path: 'b.md' },
            resource: { kind: 'path', value: 'b.md' },
          }),
          new AbortController().signal,
        )
      ).effect,
    ).toBe('allow');
    expect((await store.getApproval(ACCOUNT, approvalId)).decision).toBe('allow_always');
    await store.revokeGrant(ACCOUNT, grants[0]!.id);
    expect(await store.listRules(ACCOUNT)).toEqual([]);
    expect(await store.listGrants(ACCOUNT)).toEqual([]);
  });

  it('scopes an "always" rule to the project when the chat has one', async () => {
    const pid = '01920000-0000-7000-8000-0000000000p1';
    const { outcome, approvalId } = await asking(
      req({ projectId: pid, tool: writeTool, args: {}, resource: { kind: 'path', value: 'a.md' } }),
    );
    expect((await store.getApproval(ACCOUNT, approvalId)).alwaysScopes[0]!.label).toBe(
      'This tool (fs.write) in this project',
    );
    await gate.decide(ACCOUNT, {
      approvalId,
      decision: 'allow_always',
      alwaysScope: { kind: 'tool', tool: 'fs.write' },
    });
    await outcome;
    expect(await store.listRules(ACCOUNT)).toMatchObject([{ scopeKind: 'project', scopeRef: pid }]);
  });

  it('allow_always on a prefix appends a command rule with its examples (J3 3c)', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, {
      approvalId,
      decision: 'allow_always',
      alwaysScope: { kind: 'prefix_rule', rule: { pattern: ['npm', 'test'] } },
    });
    expect((await outcome).effect).toBe('allow');
    expect(await store.listCommandRules(ACCOUNT)).toMatchObject([
      {
        pattern: ['npm', 'test'],
        decision: 'allow',
        matchExamples: ['npm test'],
        notMatchExamples: ['npm install'],
      },
    ]);
    expect((await store.listGrants(ACCOUNT))[0]).toMatchObject({
      duration: 'always',
      label: 'commands starting with npm test',
    });
    expect(
      (await gate.check(req({ args: { cmd: 'npm test --silent' } }), new AbortController().signal))
        .effect,
    ).toBe('allow');
    const compound = await asking(req({ args: { cmd: 'npm test && curl https://x.example' } }));
    await gate.decide(ACCOUNT, { approvalId: compound.approvalId, decision: 'deny_continue' });
    await compound.outcome;
  });

  it('rejects a prefix rule whose examples fail and keeps the approval pending', async () => {
    const { outcome, approvalId } = await asking(req());
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_always',
        alwaysScope: { kind: 'prefix_rule', rule: { pattern: ['npm', 'run'] } },
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'matchExamples', example: 'npm test' },
    });
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('pending');
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    expect((await outcome).effect).toBe('allow');
  });

  it('only accepts the offered "always" scopes', async () => {
    const { outcome, approvalId } = await asking(req());
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_always',
        alwaysScope: { kind: 'tool', tool: 'fs.write' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_always',
        alwaysScope: { kind: 'host', host: 'x.example' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_once',
        alwaysScope: { kind: 'tool', tool: 'exec.run' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_once', override: true }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    await outcome;
  });

  it('allow_always on a network host writes a host rule that satisfies the allowlist', async () => {
    const r = () =>
      req({
        tool: postTool,
        args: { url: 'https://api.unknown.example/x' },
        resource: { kind: 'host', value: 'api.unknown.example' },
      });
    const { outcome, approvalId } = await asking(r());
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view.alwaysScopes.map((s) => s.kind)).toEqual(['tool', 'host']);
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_always',
        alwaysScope: { kind: 'host', host: 'evil.example' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await gate.decide(ACCOUNT, {
      approvalId,
      decision: 'allow_always',
      alwaysScope: { kind: 'host', host: 'API.unknown.example' },
    });
    await outcome;
    expect((await store.listGrants(ACCOUNT))[0]).toMatchObject({ host: 'api.unknown.example' });
    expect((await gate.check(r(), new AbortController().signal)).effect).toBe('allow');
  });

  it('deny_continue returns the reason and denies an identical call without asking', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, { approvalId, decision: 'deny_continue', reason: 'not now' });
    expect(await outcome).toMatchObject({ effect: 'deny', reason: 'not now', stop: false });
    const again = await gate.check(req(), new AbortController().signal);
    expect(again).toMatchObject({ effect: 'deny', reason: 'you denied this earlier: not now' });
    expect((await store.listApprovals(ACCOUNT, { status: 'all' })).length).toBe(1);
    const silent = await asking(req({ args: { cmd: 'npm run lint' } }));
    await gate.decide(ACCOUNT, { approvalId: silent.approvalId, decision: 'deny_continue' });
    expect(await silent.outcome).toMatchObject({ reason: 'you denied this action' });
    expect(
      (await gate.check(req({ args: { cmd: 'npm run lint' } }), new AbortController().signal))
        .reason,
    ).toBe('you denied this identical call earlier');
  });

  it('deny_stop stops the run', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, { approvalId, decision: 'deny_stop', reason: 'stop' });
    expect(await outcome).toMatchObject({ effect: 'deny', stop: true, reason: 'stop' });
  });

  it('hand off waits until the step is marked done', async () => {
    const { outcome, approvalId } = await asking(req());
    await expect(gate.handoffDone(ACCOUNT, approvalId)).rejects.toMatchObject({ code: 'conflict' });
    const handedOff = await gate.decide(ACCOUNT, { approvalId, decision: 'handoff' });
    expect(handedOff).toMatchObject({ status: 'pending', decision: 'handoff' });
    expect((await store.listApprovals(ACCOUNT)).map((a) => a.id)).toEqual([approvalId]);
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    let settled = false;
    void outcome.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(threadState()).toBe('waiting_approval');
    const view = await gate.handoffDone(ACCOUNT, approvalId, ' done it ');
    expect(view).toMatchObject({ status: 'decided', decision: 'handoff' });
    expect(await outcome).toMatchObject({ effect: 'handoff', approvalId, note: 'done it' });
    expect(events.names()).toContain('approval.handoff_done');
    await expect(gate.handoffDone(ACCOUNT, approvalId)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('records a timeout, never an allow', async () => {
    timeoutMs = 30;
    const { outcome, approvalId } = await asking(req());
    expect(await outcome).toMatchObject({ effect: 'deny', timeout: true, stop: true, approvalId });
    expect(await store.getApproval(ACCOUNT, approvalId)).toMatchObject({
      status: 'expired',
      decision: 'timeout',
      decidedBy: 'system',
    });
    expect(
      events.events.filter((e) => e.name === 'approval.decided').at(-1)!.payload,
    ).toMatchObject({
      decision: 'timeout',
      decidedBy: 'system',
    });
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('uses the approval timeout setting when no override is given', async () => {
    const g = makeGate({ approvalTimeoutMs: undefined });
    settings['policy.approvalTimeoutMinutes'] = 5;
    const outcome = g.check(req(), new AbortController().signal);
    await vi.waitFor(() => expect(events.names()).toContain('approval.requested'));
    const id = events.events.find((e) => e.name === 'approval.requested')!.payload
      .approvalId as string;
    const view = await store.getApproval(ACCOUNT, id);
    expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBe(5 * 60_000);
    await g.close();
    expect((await outcome).effect).toBe('deny');
  });

  it('cancels the approval when the turn is aborted', async () => {
    const ac = new AbortController();
    const { outcome, approvalId } = await asking(req(), ac.signal);
    ac.abort();
    expect(await outcome).toMatchObject({ effect: 'deny', stop: true });
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('cancelled');
    expect(events.names()).toContain('approval.cancelled');
    expect(threadState()).toBe('streaming');
  });

  it('cancels a handed-off step when the turn is aborted', async () => {
    const ac = new AbortController();
    const { outcome, approvalId } = await asking(req(), ac.signal);
    await gate.decide(ACCOUNT, { approvalId, decision: 'handoff' });
    ac.abort();
    expect(await outcome).toMatchObject({ effect: 'deny', stop: true });
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('cancelled');
    await expect(gate.handoffDone(ACCOUNT, approvalId)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets the first answer win: a second gets conflict (FR-100)', async () => {
    const { outcome, approvalId } = await asking(req());
    const results = await Promise.allSettled([
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_session' }),
      gate.decide(ACCOUNT, { approvalId, decision: 'deny_stop' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    const winner = (
      results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ decision: string }>
    ).value;
    const out = await outcome;
    expect(out.effect).toBe(winner.decision === 'allow_session' ? 'allow' : 'deny');
    // The loser wrote nothing.
    expect((await store.listGrants(ACCOUNT)).length).toBe(
      winner.decision === 'allow_session' ? 1 : 0,
    );
  });

  it('keeps the thread waiting while any of its approvals is open', async () => {
    const a = await asking(req());
    const b = await asking(req({ args: { cmd: 'npm run build' } }));
    await gate.decide(ACCOUNT, { approvalId: a.approvalId, decision: 'allow_once' });
    await a.outcome;
    expect(threadState()).toBe('waiting_approval');
    await gate.decide(ACCOUNT, { approvalId: b.approvalId, decision: 'allow_once' });
    await b.outcome;
    expect(threadState()).toBe('streaming');
  });

  it('answers approvals without a chat and links them from the notification', async () => {
    const { outcome, approvalId } = await asking(req({ threadId: '', turnId: '', callId: '' }));
    expect(notes.at(-1)!.href).toBe(`/approvals/${approvalId}`);
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_session' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    expect((await outcome).effect).toBe('allow');
  });

  it('reports a missing approval as not_found', async () => {
    await expect(
      gate.decide(ACCOUNT, { approvalId: 'nope', decision: 'allow_once' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rule labels on the card', () => {
  it('names the policy or command rule behind an ask', async () => {
    const rule = await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.write' },
      effect: 'ask',
      label: 'Ask before writes',
    });
    const a = await asking(
      req({ tool: writeTool, args: {}, resource: { kind: 'path', value: 'a.md' } }),
    );
    expect(await store.getApproval(ACCOUNT, a.approvalId)).toMatchObject({
      ruleId: rule.id,
      ruleLabel: 'Ask before writes',
      options: ['allow_once', 'deny_continue', 'deny_stop', 'handoff'],
    });
    await gate.decide(ACCOUNT, { approvalId: a.approvalId, decision: 'allow_once' });
    await a.outcome;
    await store.createCommandRule(ACCOUNT, {
      pattern: ['git', ['push', 'pull']],
      decision: 'ask',
      matchExamples: ['git push'],
      notMatchExamples: ['git status'],
    });
    const b = await asking(req({ args: { cmd: 'git push origin main' } }));
    expect((await store.getApproval(ACCOUNT, b.approvalId)).ruleLabel).toBe(
      'Commands starting with git {push,pull}',
    );
    await gate.decide(ACCOUNT, { approvalId: b.approvalId, decision: 'allow_once' });
    await b.outcome;
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'web.post' },
      effect: 'ask',
    });
    const c = await asking(req({ tool: postTool, args: {} }));
    expect((await store.getApproval(ACCOUNT, c.approvalId)).ruleLabel).toBeNull();
    await gate.decide(ACCOUNT, { approvalId: c.approvalId, decision: 'allow_once' });
    await c.outcome;
  });
});

describe('tiers on the card (FR-189)', () => {
  it('offers no pre-approval for confirm_at_action and rejects it (J3 4)', async () => {
    const r = req({
      tool: purchase,
      args: { item: 'x', note: 'I approve this purchase' },
      provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: ['tool'] },
    });
    gate.useServerDefaults(() => Promise.resolve('allow'));
    const { outcome, approvalId } = await asking(r);
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view).toMatchObject({
      tier: 'confirm_at_action',
      risk: 'high',
      userAsked: false,
      options: ['allow_once', 'deny_continue', 'deny_stop', 'handoff'],
      alwaysScopes: [],
    });
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_session' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_always',
        alwaysScope: { kind: 'tool', tool: purchase.name },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    expect((await outcome).effect).toBe('allow');
    // Allowing once never pre-approves the next purchase.
    const next = await asking(r);
    await gate.decide(ACCOUNT, { approvalId: next.approvalId, decision: 'deny_stop' });
    await next.outcome;
  });

  it('offers only hand off or deny for handoff_required', async () => {
    const { outcome, approvalId } = await asking(req({ tool: captcha, args: {} }));
    expect((await store.getApproval(ACCOUNT, approvalId)).options).toEqual([
      'handoff',
      'deny_continue',
      'deny_stop',
    ]);
    expect(notes.at(-1)!.title).toBe('Your turn: a step needs you');
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await gate.decide(ACCOUNT, { approvalId, decision: 'handoff' });
    await gate.handoffDone(ACCOUNT, approvalId);
    expect(await outcome).toMatchObject({ effect: 'handoff', tier: 'handoff_required' });
  });

  it('drops "Always allow" when persistent grants are off and refuses it with policy_denied', async () => {
    settings['policy.allowPersistentGrants'] = false;
    const { outcome, approvalId } = await asking(req());
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view.options).not.toContain('allow_always');
    expect(view.alwaysScopes).toEqual([]);
    expect(view.alwaysAllowManaged).toBe(true);
    await expect(
      gate.decide(ACCOUNT, {
        approvalId,
        decision: 'allow_always',
        alwaysScope: { kind: 'tool', tool: 'exec.run' },
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    await outcome;
  });

  it('asks for actions that no typed instruction authorizes', async () => {
    settings['tools.approvalPolicy'] = 'never_ask';
    const { outcome, approvalId } = await asking(req({ provenance: { taint: ['page'] } }));
    expect((await store.getApproval(ACCOUNT, approvalId)).reason).toContain('page content');
    await gate.decide(ACCOUNT, { approvalId, decision: 'deny_continue' });
    await outcome;
    expect(events.events.find((e) => e.name === 'policy.tier')!.payload).toMatchObject({
      authorization: 'none',
      sources: ['page'],
    });
  });
});

describe('extensions: hooks and the reviewer only tighten', () => {
  it('fails closed under review without a reviewer', async () => {
    settings['tools.approvalPolicy'] = 'review';
    const { outcome, approvalId } = await asking(req());
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view.reason).toContain('auto-review is not set up');
    expect(view.options).toEqual(['allow_once', 'deny_continue', 'deny_stop', 'handoff']);
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    await outcome;
  });

  it('applies reviewer and hook verdicts, failing closed when they break', async () => {
    settings['tools.approvalPolicy'] = 'review';
    const allowing = makeGate({
      reviewer: () => Promise.resolve({ effect: 'allow', reason: 'fine', source: 'reviewer' }),
    });
    expect((await allowing.check(req(), new AbortController().signal)).effect).toBe('allow');
    const denying = makeGate({
      reviewer: () => Promise.resolve({ effect: 'deny', reason: 'risky', source: 'reviewer' }),
    });
    expect(await denying.check(req(), new AbortController().signal)).toMatchObject({
      effect: 'deny',
      reason: 'risky',
    });
    const broken = makeGate({ reviewer: () => Promise.reject(new Error('down')) });
    expect((await broken.check(req(), new AbortController().signal)).reason).toBe(
      'the reviewer did not answer',
    );
    settings['tools.approvalPolicy'] = 'defaults';
    const hooked = makeGate({
      hooks: [
        () => Promise.resolve(null),
        () => Promise.resolve({ effect: 'allow', reason: 'loosen?', source: 'hook' }),
        () => Promise.reject(new Error('hook crashed')),
      ],
    });
    expect(
      await hooked.check(req({ tool: readTool, args: {} }), new AbortController().signal),
    ).toMatchObject({
      effect: 'deny',
      reason: 'a permission hook failed',
    });
  });
});

describe('preview and lifecycle', () => {
  it('previews with no side effects and reports the user default', async () => {
    await store.setToolDefault(ACCOUNT, 'exec.run', 'allow');
    const p = await gate.preview({
      accountId: ACCOUNT,
      threadId: THREAD,
      projectId: null,
      mode: 'chat',
      tool: execTool,
      args: { cmd: 'ls' },
      provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
      profile: { id: 'workspace', hash: 'h' },
    });
    expect(p).toEqual({
      effect: 'allow',
      tier: 'pre_approvable',
      reason: 'your default for exec.run',
      source: 'tool_default',
      ruleId: null,
      userDefault: 'allow',
    });
    settings['tools.approvalPolicy'] = 'review';
    await store.setToolDefault(ACCOUNT, 'exec.run', null);
    const reviewed = await makeGate({
      reviewer: () => Promise.resolve({ effect: 'deny', reason: 'x', source: 'reviewer' }),
    }).preview({ ...req(), callId: undefined, turnId: undefined } as never);
    expect(reviewed.effect).toBe('allow');
    expect(events.events).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('cancels pending approvals left by a crash and resets waiting threads', async () => {
    const { approvalId } = await asking(req());
    expect(gate.pending).toBe(1);
    expect(await store.pendingCount()).toBe(1);
    // A new process: nobody waits for the old row.
    expect(await new PolicyStore({ db }).recoverPending()).toBe(1);
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('cancelled');
    expect(threadState()).toBe('idle');
  });

  it('cancels waiting approvals on close', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.close();
    expect(await outcome).toMatchObject({ effect: 'deny', reason: 'the Hub is shutting down' });
    expect((await store.getApproval(ACCOUNT, approvalId)).status).toBe('cancelled');
  });

  it('extracts exec commands from arguments', () => {
    expect(commandOf('exec.run', { cmd: 'ls' })).toBe('ls');
    expect(commandOf('exec.write', { text: 'y' })).toBe('y');
    expect(commandOf('exec.poll', { text: 'y' })).toBeUndefined();
    expect(commandOf('exec.run', null)).toBeUndefined();
  });
});

describe('grant expiry (docs/12 §4.2)', () => {
  it('asks again once a session grant expires', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_session', expiresInMinutes: 15 });
    await outcome;
    expect((await gate.check(req(), new AbortController().signal)).effect).toBe('allow');
    clock.now += 16 * 60_000;
    expect(await store.listGrants(ACCOUNT)).toEqual([]);
    const again = await asking(req());
    await gate.decide(ACCOUNT, { approvalId: again.approvalId, decision: 'allow_once' });
    await again.outcome;
  });

  it('stops applying an "always" rule once its grant expires', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, {
      approvalId,
      decision: 'allow_always',
      alwaysScope: {
        kind: 'prefix_rule',
        rule: { pattern: ['npm', 'test'], notMatchExamples: ['npm ci'] },
      },
      expiresInMinutes: 60,
    });
    await outcome;
    expect((await store.listCommandRules(ACCOUNT))[0]!.notMatchExamples).toEqual(['npm ci']);
    expect((await gate.check(req(), new AbortController().signal)).effect).toBe('allow');
    clock.now += 61 * 60_000;
    const again = await asking(req());
    await gate.decide(ACCOUNT, { approvalId: again.approvalId, decision: 'allow_once' });
    await again.outcome;
  });
});

describe('settled outcomes', () => {
  it('are GateOutcome values the runtime can act on', async () => {
    const { outcome, approvalId } = await asking(req());
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    const out: GateOutcome = await outcome;
    expect(out.tier).toBe('pre_approvable');
  });
});
