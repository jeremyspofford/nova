// Remembered grants (FR-100, docs/12 §4.2): listing, expiry, revocation and the rules they wrote.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { PolicyStore, grantView } from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
let db: NovaDatabase;
let store: PolicyStore;
let clock: number;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  clock = Date.parse('2026-10-17T10:00:00.000Z');
  store = new PolicyStore({ db, now: () => new Date(clock) });
});
afterEach(() => db.close());

describe('grants', () => {
  it('lists active grants and gives the thread its session grants', async () => {
    await store.createGrant(ACCOUNT, {
      duration: 'session',
      scope: { kind: 'session', ref: 't1' },
      match: { tool: 'exec.run', command: ['npm', 'test'] },
      label: 'commands starting with npm test in this chat',
    });
    await store.createGrant(ACCOUNT, {
      duration: 'session',
      scope: { kind: 'session', ref: 't1' },
      match: { tool: 'web.post' },
      host: 'api.example',
      label: 'web.post on api.example in this chat',
      expiresAt: '2026-10-17T10:15:00.000Z',
    });
    await store.createGrant(ACCOUNT, {
      duration: 'session',
      scope: { kind: 'session', ref: 't1' },
      match: { tool: 'exec.run', argsHash: 'sha256:x' },
      label: 'this exact command',
    });
    expect((await store.listGrants(ACCOUNT)).map((g) => g.tool)).toEqual([
      'exec.run',
      'web.post',
      'exec.run',
    ]);
    const set = await store.policySet(ACCOUNT, { threadId: 't1' });
    expect(set.grants).toMatchObject([
      { tool: 'exec.run', command: ['npm', 'test'] },
      { tool: 'web.post', host: 'api.example' },
      { tool: 'exec.run', argsHash: 'sha256:x' },
    ]);
    expect((await store.policySet(ACCOUNT, { threadId: 't2' })).grants).toEqual([]);
    expect((await store.policySet(ACCOUNT)).grants).toEqual([]);
    clock += 20 * 60_000;
    expect((await store.listGrants(ACCOUNT)).map((g) => g.tool)).toEqual(['exec.run', 'exec.run']);
  });

  it('revokes an always grant together with the rule it wrote', async () => {
    const rule = await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.write' },
      effect: 'allow',
    });
    const g = await store.createGrant(ACCOUNT, {
      ruleId: rule.id,
      duration: 'always',
      scope: { kind: 'global' },
      match: { tool: 'fs.write' },
      label: 'fs.write everywhere',
    });
    const cmd = await store.createCommandRule(ACCOUNT, {
      pattern: ['npm', 'test'],
      decision: 'allow',
      matchExamples: ['npm test'],
      notMatchExamples: ['npm ci'],
    });
    const g2 = await store.createGrant(ACCOUNT, {
      commandRuleId: cmd.id,
      duration: 'always',
      scope: { kind: 'global' },
      match: { tool: 'exec.run', command: ['npm', 'test'] },
      label: 'commands starting with npm test',
    });
    expect(grantView(g)).toMatchObject({
      duration: 'always',
      tool: 'fs.write',
      commandRuleId: null,
    });
    await store.revokeGrant(ACCOUNT, g.id);
    await store.revokeGrant(ACCOUNT, g2.id);
    expect(await store.listRules(ACCOUNT)).toEqual([]);
    expect(await store.listCommandRules(ACCOUNT)).toEqual([]);
    expect(await store.listGrants(ACCOUNT)).toEqual([]);
    await expect(store.revokeGrant(ACCOUNT, g.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.revokeGrant(ACCOUNT, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('revokes the grants of a rule the user deletes', async () => {
    const rule = await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.write' },
      effect: 'allow',
    });
    await store.createGrant(ACCOUNT, {
      ruleId: rule.id,
      duration: 'always',
      scope: { kind: 'global' },
      match: { tool: 'fs.write' },
      label: 'fs.write',
    });
    const cmd = await store.createCommandRule(ACCOUNT, {
      pattern: ['ls'],
      decision: 'allow',
      matchExamples: ['ls'],
      notMatchExamples: ['lsof'],
    });
    await store.createGrant(ACCOUNT, {
      commandRuleId: cmd.id,
      duration: 'always',
      scope: { kind: 'global' },
      match: { tool: 'exec.run' },
      label: 'ls',
    });
    await store.deleteRule(ACCOUNT, rule.id);
    await store.deleteCommandRule(ACCOUNT, cmd.id);
    expect(await store.listGrants(ACCOUNT)).toEqual([]);
  });

  it('drops an "always" rule from the policy set once its grant expires', async () => {
    const rule = await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.write' },
      effect: 'allow',
    });
    await store.createGrant(ACCOUNT, {
      ruleId: rule.id,
      duration: 'always',
      scope: { kind: 'global' },
      match: { tool: 'fs.write' },
      label: 'fs.write for an hour',
      expiresAt: '2026-10-17T11:00:00.000Z',
    });
    expect((await store.policySet(ACCOUNT)).rules).toHaveLength(1);
    clock += 2 * 3_600_000;
    expect((await store.policySet(ACCOUNT)).rules).toEqual([]);
  });
});
