// The policy store: policy rules, per-tool defaults, approval listing (FR-048, FR-099, FR-100).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  PolicyStore,
  approvalView,
  resourceMatcher,
  ruleView,
  type ApprovalRow,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
let db: NovaDatabase;
let store: PolicyStore;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, now, now);
  store = new PolicyStore({ db });
});
afterEach(() => db.close());

describe('policy rules', () => {
  it('creates, lists, updates and deletes user rules', async () => {
    const r = await store.createRule(ACCOUNT, {
      scopeKind: 'project',
      scopeRef: 'p1',
      match: {
        tool: 'email.send',
        resource: '*@customer.example',
        effects: ['external_communication'],
      },
      effect: 'ask',
      label: 'Ask before messaging customers',
      priority: 50,
    });
    expect(r).toMatchObject({
      scopeKind: 'project',
      scopeRef: 'p1',
      match: {
        tool: 'email.send',
        resource: 'customer.example',
        effects: ['external_communication'],
      },
      effect: 'ask',
      priority: 50,
      source: 'user',
      enabled: true,
    });
    expect(await store.listRules(OTHER)).toEqual([]);
    const off = await store.updateRule(ACCOUNT, r.id, { enabled: false, label: null });
    expect(off).toMatchObject({ enabled: false, label: null, priority: 50 });
    const set = await store.policySet(ACCOUNT);
    expect(set.rules).toEqual([]);
    await store.updateRule(ACCOUNT, r.id, { enabled: true, effect: 'deny' });
    expect((await store.policySet(ACCOUNT)).rules).toMatchObject([
      { id: r.id, effect: 'deny', scope: { kind: 'project', ref: 'p1' } },
    ]);
    await store.deleteRule(ACCOUNT, r.id);
    expect(await store.listRules(ACCOUNT)).toEqual([]);
    await expect(store.deleteRule(ACCOUNT, r.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('validates scopes and effect classes', async () => {
    await expect(
      store.createRule(ACCOUNT, { scopeKind: 'tool', match: {}, effect: 'deny' }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(
      store.createRule(ACCOUNT, {
        scopeKind: 'global',
        match: { effects: ['captcha'] },
        effect: 'allow',
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    const g = await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      scopeRef: 'ignored',
      match: {},
      effect: 'allow',
    });
    expect(g.scopeRef).toBeNull();
  });

  it('keeps managed rules read-only and puts them in the managed layer', async () => {
    const m = await store.createRule(
      ACCOUNT,
      { scopeKind: 'global', match: { tool: 'exec.run' }, effect: 'ask' },
      'managed',
    );
    await expect(store.updateRule(ACCOUNT, m.id, { enabled: false })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(store.deleteRule(ACCOUNT, m.id)).rejects.toMatchObject({ code: 'policy_denied' });
    const set = await store.policySet(ACCOUNT);
    expect(set.managed?.map((r) => r.id)).toEqual([m.id]);
    expect(set.rules).toEqual([]);
  });

  it('maps resource strings to paths, recipients and hosts', () => {
    expect(resourceMatcher('/work/src')).toEqual({ kind: 'path', pathPrefix: '/work/src' });
    expect(resourceMatcher('~/notes')).toEqual({ kind: 'path', pathPrefix: '~/notes' });
    expect(resourceMatcher('C:\\work')).toEqual({ kind: 'path', pathPrefix: 'C:\\work' });
    expect(resourceMatcher('pat@team.example')).toEqual({
      kind: 'account',
      pattern: 'pat@team.example',
    });
    expect(resourceMatcher('*@team.example')).toEqual({ host: 'team.example' });
    expect(resourceMatcher('*.bank.example')).toEqual({ host: '*.bank.example' });
  });

  it('expands ~ in path rules for the engine and shows rules from other sources', async () => {
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { resource: '~/notes' },
      effect: 'deny',
    });
    expect(
      (await store.policySet(ACCOUNT, { home: '/home/u' })).rules?.[0]?.match.resource,
    ).toEqual({
      kind: 'path',
      pathPrefix: '/home/u/notes',
    });
    const view = ruleView({
      id: 'x',
      accountId: ACCOUNT,
      scopeKind: 'site',
      scopeRef: '*.bank.example',
      actionMatch: JSON.stringify({ tool: ['a.b', 'c.d'], resource: { pattern: 'x*' } }),
      effect: 'deny',
      label: null,
      priority: 100,
      source: 'plugin',
      enabled: true,
      createdAt: 'now',
      updatedAt: 'now',
    });
    expect(view.match).toEqual({ tool: 'a.b, c.d', resource: 'x*' });
    expect(
      ruleView({
        id: 'y',
        accountId: ACCOUNT,
        scopeKind: 'global',
        scopeRef: null,
        actionMatch: 'not json',
        effect: 'allow',
        label: null,
        priority: 100,
        source: 'user',
        enabled: true,
        createdAt: 'now',
        updatedAt: 'now',
      }).match,
    ).toEqual({});
  });
});

describe('per-tool defaults (FR-048)', () => {
  it('sets, replaces, lists and clears defaults per account', async () => {
    expect(await store.setToolDefault(ACCOUNT, 'exec.run', 'ask')).toEqual({
      tool: 'exec.run',
      default: 'ask',
    });
    await store.setToolDefault(ACCOUNT, 'exec.run', 'deny');
    await store.setToolDefault(ACCOUNT, 'mcp:linear.*', 'allow');
    expect(await store.listToolDefaults(ACCOUNT)).toEqual([
      { tool: 'exec.run', default: 'deny' },
      { tool: 'mcp:linear.*', default: 'allow' },
    ]);
    expect(await store.listToolDefaults(OTHER)).toEqual([]);
    expect(await store.setToolDefault(ACCOUNT, 'exec.run', null)).toEqual({
      tool: 'exec.run',
      default: null,
    });
    expect((await store.policySet(ACCOUNT)).toolDefaults).toEqual({ 'mcp:linear.*': 'allow' });
  });
});

describe('approval rows', () => {
  const row = (over: Partial<ApprovalRow>): ApprovalRow => ({
    id: 'a1',
    accountId: ACCOUNT,
    toolCallId: 'c1',
    threadId: 't1',
    turnId: 'u1',
    runId: null,
    agentId: null,
    toolName: 'exec.run',
    requestedAction: 'Run `ls`',
    argsPreview: '{}',
    argsHash: 'h',
    reason: 'because',
    scope: 'thread:t1',
    risk: 'low',
    tier: 'pre_approvable',
    userAsked: true,
    optionsJson: '["allow_once"]',
    alwaysScopesJson: '[]',
    reviewJson: null,
    status: 'pending',
    decision: null,
    alwaysScope: null,
    alwaysRef: null,
    denyReason: null,
    override: false,
    decidedBy: null,
    decidedDeviceId: null,
    decidedAt: null,
    handoffNote: null,
    handoffDoneAt: null,
    expiresAt: '2030-01-01T00:00:00.000Z',
    ruleId: null,
    ruleLabel: null,
    alwaysAllowManaged: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('lists pending approvals newest first, filtered by thread, scoped to the account', async () => {
    await store.insertApproval(row({ id: 'a1', createdAt: '2026-01-01T00:00:01.000Z' }));
    await store.insertApproval(
      row({ id: 'a2', threadId: 't2', createdAt: '2026-01-01T00:00:02.000Z' }),
    );
    await store.insertApproval(
      row({
        id: 'a3',
        status: 'decided',
        decision: 'allow_once',
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    );
    await store.insertApproval(row({ id: 'a4', accountId: OTHER }));
    expect((await store.listApprovals(ACCOUNT)).map((a) => a.id)).toEqual(['a2', 'a1']);
    expect((await store.listApprovals(ACCOUNT, { status: 'all' })).map((a) => a.id)).toEqual([
      'a3',
      'a2',
      'a1',
    ]);
    expect(
      (await store.listApprovals(ACCOUNT, { threadId: 't1', status: 'all' })).map((a) => a.id),
    ).toEqual(['a3', 'a1']);
    await expect(store.getApproval(ACCOUNT, 'a4')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('enforces the tier limits in the database (docs/06 invariant 10)', async () => {
    await expect(
      store.insertApproval(
        row({ id: 'b1', tier: 'confirm_at_action', status: 'decided', decision: 'allow_session' }),
      ),
    ).rejects.toThrow();
    await expect(
      store.insertApproval(
        row({ id: 'b2', tier: 'handoff_required', status: 'decided', decision: 'allow_once' }),
      ),
    ).rejects.toThrow();
    await expect(
      store.insertApproval(row({ id: 'b3', status: 'decided', decision: 'allow_always' })),
    ).rejects.toThrow();
  });

  it('remembers the reason of a deny-and-continue for the same thread, tool and arguments', async () => {
    await store.insertApproval(
      row({
        id: 'd1',
        status: 'decided',
        decision: 'deny_continue',
        denyReason: 'no',
        decidedAt: 'x',
      }),
    );
    await store.insertApproval(
      row({
        id: 'd2',
        toolName: 'fs.write',
        status: 'decided',
        decision: 'deny_continue',
        denyReason: null,
      }),
    );
    expect(store.deniedBefore(ACCOUNT, 't1', 'exec.run', 'h')).toBe('no');
    expect(store.deniedBefore(ACCOUNT, 't1', 'fs.write', 'h')).toBe('');
    expect(store.deniedBefore(ACCOUNT, 't2', 'exec.run', 'h')).toBeNull();
  });

  it('maps rows to views, tolerating bad JSON', () => {
    const v = approvalView(row({ optionsJson: 'nope', expiresAt: null, tier: null, reason: null }));
    expect(v).toMatchObject({
      options: [],
      expiresAt: v.createdAt,
      tier: 'pre_approvable',
      reason: '',
    });
  });
});
