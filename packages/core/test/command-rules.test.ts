// Command prefix rules in the store (FR-191, docs/12 §3.1): load-time examples, re-checks on
// edit, the test endpoint and the last good rule set.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { PolicyStore } from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
let db: NovaDatabase;
let store: PolicyStore;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  store = new PolicyStore({ db });
});
afterEach(() => db.close());

const gitRead = {
  pattern: ['git', ['status', 'diff', 'log']],
  decision: 'allow' as const,
  justification: 'Read-only Git inspection.',
  matchExamples: ['git status', 'git log -n 5'],
  notMatchExamples: ['git push origin main', 'sudo git status'],
};

describe('command rules', () => {
  it('stores a rule only when its examples pass', async () => {
    const r = await store.createCommandRule(ACCOUNT, gitRead);
    expect(r).toMatchObject({
      scopeKind: 'global',
      scopeRef: null,
      pattern: ['git', ['status', 'diff', 'log']],
      decision: 'allow',
      matchExamples: ['git status', 'git log -n 5'],
      source: 'user',
      enabled: true,
      priority: 100,
    });
    expect(await store.listCommandRules(ACCOUNT)).toHaveLength(1);
  });

  it('rejects a failing example with the field and the example (settings UI)', async () => {
    await expect(
      store.createCommandRule(ACCOUNT, { ...gitRead, matchExamples: ['git push'] }),
    ).rejects.toMatchObject({
      code: 'validation',
      message: 'the example "git push" should match the rule but does not',
      details: { field: 'matchExamples', example: 'git push' },
    });
    await expect(
      store.createCommandRule(ACCOUNT, { ...gitRead, notMatchExamples: ['git diff'] }),
    ).rejects.toMatchObject({ details: { field: 'notMatchExamples', example: 'git diff' } });
    await expect(
      store.createCommandRule(ACCOUNT, { ...gitRead, matchExamples: [] }),
    ).rejects.toMatchObject({
      details: { field: 'matchExamples' },
    });
    await expect(
      store.createCommandRule(ACCOUNT, { ...gitRead, notMatchExamples: [] }),
    ).rejects.toMatchObject({
      details: { field: 'notMatchExamples' },
    });
    await expect(
      store.createCommandRule(ACCOUNT, { ...gitRead, pattern: ['git status'] }),
    ).rejects.toMatchObject({
      details: { field: 'pattern' },
    });
    await expect(
      store.createCommandRule(ACCOUNT, { ...gitRead, scopeKind: 'project' }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(await store.listCommandRules(ACCOUNT)).toEqual([]);
  });

  it('re-checks examples on edit and keeps the old rule when they fail', async () => {
    const r = await store.createCommandRule(ACCOUNT, gitRead);
    await expect(
      store.updateCommandRule(ACCOUNT, r.id, { pattern: ['git', 'show'] }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'matchExamples', example: 'git status' },
    });
    expect((await store.listCommandRules(ACCOUNT))[0]!.pattern).toEqual(gitRead.pattern);
    const next = await store.updateCommandRule(ACCOUNT, r.id, {
      pattern: ['git', 'show'],
      matchExamples: ['git show HEAD'],
      notMatchExamples: ['git push'],
      enabled: false,
      justification: null,
      scopeKind: 'project',
      scopeRef: 'p1',
    });
    expect(next).toMatchObject({
      pattern: ['git', 'show'],
      enabled: false,
      justification: null,
      scopeKind: 'project',
      createdAt: r.createdAt,
    });
    await store.deleteCommandRule(ACCOUNT, r.id);
    expect(await store.listCommandRules(ACCOUNT)).toEqual([]);
    await expect(store.updateCommandRule(ACCOUNT, r.id, {})).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keeps managed command rules read-only and evaluates them first', async () => {
    const m = await store.createCommandRule(
      ACCOUNT,
      {
        pattern: ['git'],
        decision: 'ask',
        matchExamples: ['git status'],
        notMatchExamples: ['ls'],
      },
      'managed',
    );
    await store.createCommandRule(ACCOUNT, gitRead);
    await expect(store.updateCommandRule(ACCOUNT, m.id, { enabled: false })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(store.deleteCommandRule(ACCOUNT, m.id)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(await store.testCommand(ACCOUNT, 'git status')).toMatchObject({
      decision: 'ask',
      ruleId: m.id,
    });
  });

  it('tests commands against the rules, optionally within scopes', async () => {
    const r = await store.createCommandRule(ACCOUNT, gitRead);
    await store.createCommandRule(ACCOUNT, {
      pattern: ['rm', ['-rf', '-r']],
      decision: 'deny',
      justification: 'Use fs.delete.',
      matchExamples: ['rm -rf build'],
      notMatchExamples: ['rm a.o'],
      scopeKind: 'project',
      scopeRef: 'p1',
    });
    expect(await store.testCommand(ACCOUNT, 'git status')).toEqual({
      decision: 'allow',
      ruleId: r.id,
      reason: 'Read-only Git inspection.',
    });
    expect((await store.testCommand(ACCOUNT, 'git status && rm -rf /')).decision).toBe('deny');
    expect(
      (await store.testCommand(ACCOUNT, 'git status && rm -rf /', [{ kind: 'project', ref: 'p2' }]))
        .decision,
    ).toBeNull();
    expect(
      (await store.testCommand(ACCOUNT, 'git status && rm -rf /', [{ kind: 'project', ref: 'p1' }]))
        .decision,
    ).toBe('deny');
    expect(await store.testCommand(ACCOUNT, 'git status && curl x')).toMatchObject({
      decision: null,
      reason: '"curl x" is not covered by a command rule',
    });
  });

  it('keeps the last good rule set when the stored rules no longer pass their examples', async () => {
    const r = await store.createCommandRule(ACCOUNT, gitRead);
    expect((await store.policySet(ACCOUNT)).commandRules?.map((c) => c.id)).toEqual([r.id]);
    // A row edited behind the store's back with an example that fails rejects the whole set.
    db.raw
      .prepare('UPDATE command_rule SET match_examples_json = ? WHERE id = ?')
      .run('["git push"]', r.id);
    expect((await store.policySet(ACCOUNT)).commandRules?.map((c) => c.id)).toEqual([r.id]);
    expect(store.commandRuleErrors.get(ACCOUNT)).toContain('git push');
    const fresh = new PolicyStore({ db });
    expect((await fresh.policySet(ACCOUNT)).commandRules).toEqual([]);
    db.raw
      .prepare('UPDATE command_rule SET match_examples_json = ? WHERE id = ?')
      .run('["git status"]', r.id);
    expect((await store.policySet(ACCOUNT)).commandRules).toHaveLength(1);
    expect(store.commandRuleErrors.has(ACCOUNT)).toBe(false);
  });
});
