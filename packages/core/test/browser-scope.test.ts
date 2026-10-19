// Site levels per project and per agent (M7, docs/11 §4.4) through the real policy gate: the
// narrower scope wins (agent, then project, then the account), each scoped level is its own
// site-scoped rule, managed rules and denies on browser.act still decide, the scope of a thread
// comes from its project and its agent along its parents, and a scope that cannot be read fails
// closed. Blocking or removing a site, or deleting its scope, removes its scoped levels.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reviewer } from '../src/index.ts';
import { hookMatches } from '../src/hooks/config.ts';
import { browserThreadScope, browserScopedActTool } from '../src/browser/index.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import type { FakePage } from './browser-fake.ts';

const PROJECT = '01920000-0000-7000-8000-0000000000d1';
const OTHER_PROJECT = '01920000-0000-7000-8000-0000000000d2';
const AGENT = '01920000-0000-7000-8000-0000000000e1';
const AGENT_THREAD = '01920000-0000-7000-8000-0000000000b2';
const CHILD_THREAD = '01920000-0000-7000-8000-0000000000b3';
const PROJECT_THREAD = '01920000-0000-7000-8000-0000000000b4';

const PAGE: FakePage = {
  title: 'Notes',
  text: 'A notes app.',
  elements: [{ role: 'button', tag: 'button', name: 'Show details' }],
};

let env: BrowserEnv;

function seed(): void {
  const now = new Date().toISOString();
  const run = (sql: string, ...args: (string | number | null)[]) =>
    env.db.raw.prepare(sql).run(...args);
  for (const [id, name] of [
    [PROJECT, 'Acme'],
    [OTHER_PROJECT, 'Other'],
  ])
    run(
      "INSERT INTO project (id, account_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, 'work', ?, ?)",
      id!,
      ACCOUNT,
      name!,
      now,
      now,
    );
  run(
    'INSERT INTO agent (id, account_id, name, time_budget_s, token_budget, created_at, updated_at) VALUES (?, ?, ?, 3600, 100000, ?, ?)',
    AGENT,
    ACCOUNT,
    'Researcher',
    now,
    now,
  );
  run(
    "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'agent', 'idle', ?, ?)",
    AGENT_THREAD,
    ACCOUNT,
    now,
    now,
  );
  run(
    "INSERT INTO thread (id, account_id, project_id, mode, parent_thread_id, state, created_at, updated_at) VALUES (?, ?, ?, 'work', ?, 'idle', ?, ?)",
    CHILD_THREAD,
    ACCOUNT,
    PROJECT,
    AGENT_THREAD,
    now,
    now,
  );
  run(
    "INSERT INTO thread (id, account_id, project_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, 'work', 'idle', ?, ?)",
    PROJECT_THREAD,
    ACCOUNT,
    PROJECT,
    now,
    now,
  );
  run(
    "INSERT INTO agent_thread (thread_id, agent_id, account_id, kind, created_at) VALUES (?, ?, ?, 'main', ?)",
    AGENT_THREAD,
    AGENT,
    ACCOUNT,
    now,
  );
}

beforeEach(async () => {
  env = await makeBrowserEnv();
  seed();
  env.driver.pages.set('https://notes.example/', PAGE);
  await env.service.sites.put(ACCOUNT, {
    pattern: 'notes.example',
    access: 'allow',
    level: 'always_ask',
  });
});

afterEach(async () => {
  await env.close();
});

/** Open the site in a thread and click its button (a write: classified, not passive). */
async function clickIn(threadId: string, projectId: string | null = null) {
  const c = () => env.call({ threadId, projectId, computerId: `c-${threadId}` });
  expect((await env.service.navigate(c(), 'https://notes.example/')).ok).toBe(true);
  expect((await env.service.read(c())).ok).toBe(true);
  return env.service.write(c(), { kind: 'click', ref: 'e1' });
}

describe('scoped levels as data', () => {
  it('sets, lists and removes a level per project and agent, each with its own rule', async () => {
    const v = await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'Notes.Example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    expect(v).toMatchObject({
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'agent',
      scopeRef: AGENT,
      level: 'auto_review',
    });
    const rules = await env.store.listRules(ACCOUNT);
    expect(rules).toHaveLength(3);
    expect(
      rules.find((r) => r.match.tool === browserScopedActTool('project', PROJECT)),
    ).toMatchObject({
      scopeKind: 'site',
      scopeRef: 'notes.example',
      effect: 'allow',
      label: expect.stringContaining('project "Acme"') as unknown,
    });
    // The site list shows the account entry with its scoped levels; nothing else is listed.
    const sites = env.service.sites.list(ACCOUNT);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.scopedLevels.map((l) => l.scopeKind).sort()).toEqual(['agent', 'project']);
    expect(env.service.sites.scopedLevels(ACCOUNT, { scopeKind: 'agent' })).toHaveLength(1);
    expect(env.service.sites.scopedLevels(ACCOUNT, { scopeRef: PROJECT })[0]!.level).toBe(
      'always_allow',
    );
    // Changing a level updates the same rule.
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_ask',
    });
    expect(await env.store.listRules(ACCOUNT)).toHaveLength(3);
    await env.service.sites.removeScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
    });
    expect(await env.store.listRules(ACCOUNT)).toHaveLength(2);
    await expect(
      env.service.sites.removeScoped(ACCOUNT, {
        pattern: 'notes.example',
        scopeKind: 'project',
        scopeRef: PROJECT,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // The proxy and the navigation guard see only the account's patterns.
    expect((await env.service.sites.networkLists(ACCOUNT)).allow).toEqual(['notes.example']);
    expect(env.service.sites.domains(ACCOUNT)).toEqual({ allow: ['notes.example'], deny: [] });
  });

  it('refuses a level for a site that is not allowed, or a scope that does not exist', async () => {
    const put = (over: Record<string, string>) =>
      env.service.sites.putScoped(ACCOUNT, {
        pattern: 'notes.example',
        scopeKind: 'project',
        scopeRef: PROJECT,
        level: 'always_allow',
        ...over,
      });
    await expect(put({ pattern: 'nowhere.example' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(put({ scopeRef: '01920000-0000-7000-8000-0000000000ff' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(put({ scopeKind: 'agent', scopeRef: PROJECT })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(put({ scopeRef: 'not an id' })).rejects.toMatchObject({ code: 'validation' });
    await env.service.sites.put(ACCOUNT, { pattern: 'bad.example', access: 'block' });
    await expect(put({ pattern: 'bad.example' })).rejects.toMatchObject({ code: 'validation' });
    // Another account's project is not one of ours.
    env.db.raw
      .prepare('UPDATE project SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), OTHER_PROJECT);
    await expect(put({ scopeRef: OTHER_PROJECT })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('blocking or removing the site, or deleting the scope, removes its scoped levels', async () => {
    const set = (scopeKind: 'project' | 'agent', scopeRef: string) =>
      env.service.sites.putScoped(ACCOUNT, {
        pattern: 'notes.example',
        scopeKind,
        scopeRef,
        level: 'always_allow',
      });
    await set('project', PROJECT);
    await set('agent', AGENT);
    expect(await env.service.sites.removeScope(ACCOUNT, 'agent', AGENT)).toBe(1);
    expect(env.service.sites.scopedLevels(ACCOUNT)).toHaveLength(1);
    await env.service.sites.put(ACCOUNT, { pattern: 'notes.example', access: 'block' });
    expect(env.service.sites.scopedLevels(ACCOUNT)).toEqual([]);
    expect(await env.store.listRules(ACCOUNT)).toEqual([]);
    await env.service.sites.put(ACCOUNT, { pattern: 'notes.example', access: 'allow' });
    await set('project', PROJECT);
    await env.service.sites.remove(ACCOUNT, 'notes.example');
    expect(env.service.sites.scopedLevels(ACCOUNT)).toEqual([]);
    expect(await env.store.listRules(ACCOUNT)).toEqual([]);
  });
});

describe('the scope of a thread', () => {
  it('is the nearest project and agent along its parents', () => {
    expect(browserThreadScope(env.db, ACCOUNT, CHILD_THREAD)).toEqual({
      projectId: PROJECT,
      agentId: AGENT,
    });
    expect(browserThreadScope(env.db, ACCOUNT, PROJECT_THREAD)).toEqual({
      projectId: PROJECT,
      agentId: null,
    });
    expect(browserThreadScope(env.db, ACCOUNT, THREAD)).toEqual({ projectId: null, agentId: null });
    // Another account's thread gives nothing.
    expect(browserThreadScope(env.db, 'someone-else', CHILD_THREAD)).toEqual({
      projectId: null,
      agentId: null,
    });
  });

  it('decides the level for a scope: the agent beats the project, the project the account', async () => {
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    const d = (scope?: { projectId: string | null; agentId: string | null }) =>
      env.service.sites.decide(ACCOUNT, 'notes.example', scope);
    expect(await d()).toMatchObject({ level: 'always_ask', scope: { kind: 'account' } });
    expect(await d({ projectId: PROJECT, agentId: null })).toMatchObject({
      level: 'always_allow',
      scope: { kind: 'project', ref: PROJECT },
      actTool: `browser.act:project:${PROJECT}`,
    });
    expect(await d({ projectId: OTHER_PROJECT, agentId: null })).toMatchObject({
      level: 'always_ask',
      actTool: 'browser.act',
    });
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'agent',
      scopeRef: AGENT,
      level: 'auto_review',
    });
    expect(await d({ projectId: PROJECT, agentId: AGENT })).toMatchObject({
      level: 'auto_review',
      scope: { kind: 'agent', ref: AGENT },
    });
  });
});

describe('scoped levels through the gate', () => {
  it("a project's Always allow runs there without asking; elsewhere the account's Always ask asks", async () => {
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    const inProject = await clickIn(PROJECT_THREAD);
    expect(inProject.ok).toBe(true);
    expect(env.approvals()).toEqual([]);
    // The plain thread is not in the project: the account level asks.
    const outside = clickIn(THREAD);
    const a = await env.answer('deny_continue');
    expect(a.action).toContain('Click "Show details"');
    expect(await outside).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(env.approvals().map((x) => x.tool)).toEqual(['browser.act']);
  });

  it("an agent's Always ask beats its project's Always allow (the narrower scope wins)", async () => {
    for (const [scopeKind, scopeRef, level] of [
      ['project', PROJECT, 'always_allow'],
      ['agent', AGENT, 'always_ask'],
    ] as const)
      await env.service.sites.putScoped(ACCOUNT, {
        pattern: 'notes.example',
        scopeKind,
        scopeRef,
        level,
      });
    await env.service.sites.patch(ACCOUNT, 'notes.example', { level: 'always_allow' });
    const click = clickIn(CHILD_THREAD);
    await env.answer('allow_once');
    expect((await click).ok).toBe(true);
    // The card, hooks and audit see browser.act; only rule matching used the agent's name.
    expect(env.approvals().map((x) => x.tool)).toEqual(['browser.act']);
    // The project's own thread (no agent) runs at the project's level.
    expect((await clickIn(PROJECT_THREAD)).ok).toBe(true);
    expect(env.approvals()).toHaveLength(1);
  });

  it('confirmation tiers still apply at a scoped Always allow', async () => {
    env.driver.pages.set('https://notes.example/', {
      title: 'Notes',
      text: 'Buy more storage.',
      elements: [{ role: 'button', tag: 'button', name: 'Buy now' }],
    });
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    const buy = clickIn(PROJECT_THREAD);
    const a = await env.answer('deny_continue');
    expect(a.tier).toBe('confirm_at_action');
    expect((await buy).ok).toBe(false);
  });

  it('a managed rule or a deny rule on browser.act still decides inside a scope', async () => {
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    const managed = await env.store.createRule(
      ACCOUNT,
      {
        scopeKind: 'global',
        match: { tool: 'browser.act' },
        effect: 'ask',
        label: 'Every page write asks',
      },
      'managed',
    );
    const click = clickIn(PROJECT_THREAD);
    await env.answer('deny_continue');
    expect((await click).ok).toBe(false);
    expect(env.approvals().map((x) => x.tool)).toEqual(['browser.act']);
    await env.store.deleteRule(ACCOUNT, managed.id).catch(() => undefined);
    env.db.raw.prepare('DELETE FROM policy_rule WHERE id = ?').run(managed.id);
    // The user's own deny on browser.act for the site wins too.
    await env.store.createRule(ACCOUNT, {
      scopeKind: 'site',
      scopeRef: 'notes.example',
      match: { tool: 'browser.act' },
      effect: 'deny',
      label: 'Never write on notes',
    });
    expect(
      await env.service.write(
        env.call({ threadId: PROJECT_THREAD, computerId: `c-${PROJECT_THREAD}` }),
        { kind: 'click', ref: 'e1' },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'denied' },
    });
  });

  it('fails closed when the scope of the thread cannot be read', async () => {
    env.service.useScopeResolver(() => Promise.reject(new Error('database is locked')));
    const out = await clickIn(PROJECT_THREAD);
    expect(out).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(env.approvals()).toEqual([]);
  });

  it('fails closed when the engine cannot be asked about a scoped level', async () => {
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    const c = () => env.call({ threadId: PROJECT_THREAD, computerId: 'c-p' });
    await env.service.navigate(c(), 'https://notes.example/');
    await env.service.read(c());
    env.service.useGate({
      check: (req, signal) => env.gate.check(req, signal),
      preview: () => Promise.reject(new Error('engine down')),
    });
    expect(await env.service.write(c(), { kind: 'click', ref: 'e1' })).toMatchObject({
      ok: false,
      error: {
        code: 'denied',
        message: expect.stringContaining('policy engine failed') as unknown,
      },
    });
  });

  it('hooks and tool limits on browser.act still see a write under a scoped level (review 3)', async () => {
    await env.service.sites.patch(ACCOUNT, 'notes.example', { level: 'always_allow' });
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'always_allow',
    });
    // A permission.request hook with the matcher browser.act that blocks every page write.
    const seen: string[] = [];
    const def = { event: 'permission.request', matcher: 'browser.act' } as never;
    env.gate.useHooks({
      dispatch: (event: string, input: { tool?: { name: string } }) => {
        seen.push(String(input.tool?.name));
        if (event === 'permission.request' && hookMatches(def, input.tool?.name))
          return Promise.resolve({
            context: [],
            block: { reason: 'no page writes', hookId: 'h1' },
          });
        return Promise.resolve({ context: [] });
      },
    });
    const blocked = await clickIn(PROJECT_THREAD);
    expect(blocked).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(seen).toContain('browser.act');
    expect(seen.some((n) => n.includes(':'))).toBe(false);
    // A thread's tool limit that denies browser.act applies too.
    env.gate.useHooks({ dispatch: () => Promise.resolve({ context: [] }) });
    env.gate.useToolLimits({
      forThread: () => Promise.resolve({ deny: ['browser.act'], reason: 'no page writes here' }),
    });
    expect(await clickIn(PROJECT_THREAD)).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(
      env.audit.filter((a) => typeof a.detail?.tool === 'string' && a.detail.tool.includes(':')),
    ).toEqual([]);
  });

  it('a scoped Auto approve with review still asks when the reviewer asks', async () => {
    const reviewer = {
      review: () =>
        Promise.resolve({ outcome: 'ask', rationale: 'unsure', failed: false } as never),
    } as Reviewer;
    env.service.useReviewer(reviewer);
    await env.service.sites.putScoped(ACCOUNT, {
      pattern: 'notes.example',
      scopeKind: 'project',
      scopeRef: PROJECT,
      level: 'auto_review',
    });
    const click = clickIn(PROJECT_THREAD);
    const a = await env.answer('deny_continue');
    expect(a.action).toContain('Auto-review asked');
    expect((await click).ok).toBe(false);
  });
});
