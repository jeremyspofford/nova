// Code sessions (FR-061, FR-063, FR-066, FR-073, FR-215): creating a session binds a code thread,
// the local environment, a checked folder and a permission mode; modes map to approval policy,
// profile and roots, are remembered per folder (except Plan) and audited; the Environment block
// and the blocked status come from the session; worktrees are created hook-free and released.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODE_AXES, modePolicy, type TerminalManager } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { HostSandbox, makeCodeEnv, type CodeEnv } from './code-env.ts';

let env: CodeEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('code sessions (FR-061)', () => {
  it('creates a code thread bound to the local environment, the folder and a mode', async () => {
    env = await makeCodeEnv();
    const view = await env.svc.create(ACCOUNT, { folder: env.repo, title: 'Fix it' });
    expect(view).toMatchObject({
      title: 'Fix it',
      permissionMode: 'manual',
      folder: { path: env.repo, projectFolderId: null },
      repo: { root: env.repo, branch: 'main', dirty: false, defaultBranch: 'main' },
      derived: { status: 'ready', reason: null },
    });
    const thread = await env.threads.view(ACCOUNT, view.threadId);
    expect(thread.mode).toBe('code');
    const envs = await env.svc.environments(ACCOUNT);
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({ id: view.environmentId, kind: 'local', label: 'This Hub' });
    // Without a sandbox commands cannot run: the environment is degraded, not down.
    expect(envs[0]!.status).toBe('degraded');
    expect(env.events.names()).toContain('code.session.created');
    expect((await env.svc.list(ACCOUNT)).map((s) => s.id)).toEqual([view.id]);
    expect((await env.svc.get(ACCOUNT, view.id)).id).toBe(view.id);
    // Sessions run in parallel: a second one on the same folder is independent.
    const second = await env.svc.create(ACCOUNT, { folder: env.repo });
    expect(second.threadId).not.toBe(view.threadId);
    expect(second.title).toBe('repo');
  });

  it('refuses missing, relative and protected folders', async () => {
    env = await makeCodeEnv();
    const e = env;
    const refuse = (folder: string) => e.svc.create(ACCOUNT, { folder });
    await expect(refuse(join(e.home, 'nope'))).rejects.toMatchObject({ code: 'validation' });
    await expect(refuse('relative/path')).rejects.toMatchObject({ code: 'validation' });
    await expect(refuse(join(e.repo, 'app.ts'))).rejects.toMatchObject({ code: 'validation' });
    await expect(refuse('/')).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(refuse('/etc')).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(refuse(e.home)).rejects.toMatchObject({ code: 'policy_denied' });
    mkdirSync(e.dataDir, { recursive: true });
    await expect(refuse(e.dataDir)).rejects.toMatchObject({ code: 'policy_denied' });
    mkdirSync(join(e.home, '.ssh'));
    await expect(refuse(join(e.home, '.ssh'))).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(refuse(join(e.repo, '.git'))).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(refuse('~/repo').then((v) => v.folder.path)).resolves.toBe(e.repo);
  });

  it('binds a project folder that contains the session folder', async () => {
    env = await makeCodeEnv();
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        "INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES ('p1', ?, 'P', ?, ?)",
      )
      .run(ACCOUNT, now, now);
    env.db.raw
      .prepare(
        "INSERT INTO project_folder (id, project_id, path, access, created_at, updated_at) VALUES ('f1', 'p1', ?, 'write', ?, ?)",
      )
      .run(env.home, now, now);
    const view = await env.svc.create(ACCOUNT, { folder: env.repo, projectId: 'p1' });
    expect(view.folder.projectFolderId).toBe('f1');
    expect((await env.threads.view(ACCOUNT, view.threadId)).projectId).toBe('p1');
    await expect(
      env.svc.create(ACCOUNT, { folder: env.repo, projectId: 'nope' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('permission modes (FR-063)', () => {
  it('maps every mode to the preset axes with the folder as the only root', () => {
    const c = { reviewerModel: 'mock:r', allowBypass: true, substrate: 'container' as const };
    expect(modePolicy('manual', '/w', c)).toEqual({
      approvalPolicy: 'ask_always',
      profileId: 'workspace',
      roots: [{ path: '/w', access: 'write', label: 'w' }],
      permissionMode: 'manual',
      autoAcceptEdits: false,
    });
    expect(modePolicy('accept_edits', '/w', c)).toMatchObject({
      approvalPolicy: 'defaults',
      profileId: 'workspace',
      autoAcceptEdits: true,
    });
    expect(modePolicy('plan', '/w', c)).toMatchObject({
      approvalPolicy: 'ask_always',
      profileId: 'read-only',
      roots: [{ access: 'read' }],
    });
    expect(modePolicy('auto', '/w', c)).toMatchObject({
      approvalPolicy: 'review',
      profileId: 'workspace',
    });
    expect(modePolicy('bypass', '/w', c)).toMatchObject({
      approvalPolicy: 'never_ask',
      profileId: 'full',
    });
    // Conditions that lapsed fail closed to Manual's axes.
    const none = { reviewerModel: null, allowBypass: false, substrate: null };
    expect(modePolicy('auto', '/w', none)).toMatchObject({
      permissionMode: 'manual',
      ...MODE_AXES.manual,
      autoAcceptEdits: false,
    });
    expect(modePolicy('bypass', '/w', { ...c, substrate: 'os_sandbox' })).toMatchObject({
      approvalPolicy: 'ask_always',
      permissionMode: 'manual',
    });
  });

  it('gives the gate the session policy through forThread, and null for other threads', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'accept_edits' });
    expect(await env.svc.policy.forThread(ACCOUNT, s.threadId)).toMatchObject({
      approvalPolicy: 'defaults',
      autoAcceptEdits: true,
      roots: [{ path: env.repo, access: 'write' }],
      permissionMode: 'accept_edits',
    });
    const chat = await env.threads.create(ACCOUNT, { mode: 'chat' });
    expect(await env.svc.policy.forThread(ACCOUNT, chat.id)).toBeNull();
    expect(await env.svc.policy.forThread('someone-else', s.threadId)).toBeNull();
  });

  it('refuses Auto without a reviewer model and Bypass without the setting and a container', async () => {
    env = await makeCodeEnv();
    await expect(
      env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'auto' }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'mode_unavailable' },
    });
    await expect(
      env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'bypass' }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    env.values['code.allowBypass'] = true;
    // No sandbox substrate yet.
    await expect(
      env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'bypass' }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
    env.sandbox.current = new HostSandbox();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'bypass' });
    expect(s.permissionMode).toBe('bypass');
    // The setting is turned off later: the session runs with Manual's axes.
    env.values['code.allowBypass'] = false;
    expect(await env.svc.policy.forThread(ACCOUNT, s.threadId)).toMatchObject({
      approvalPolicy: 'ask_always',
      permissionMode: 'manual',
    });
    env.values['review.model'] = 'mock:reviewer';
    expect(
      (await env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'auto' })).permissionMode,
    ).toBe('auto');
  });

  it('remembers the mode per folder except Plan, and audits every change', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'accept_edits' });
    expect(env.remembered).toEqual([{ folder: env.repo, mode: 'accept_edits' }]);
    // A new session in the folder starts in the remembered mode.
    expect((await env.svc.create(ACCOUNT, { folder: env.repo })).permissionMode).toBe(
      'accept_edits',
    );
    const planned = await env.svc.update(ACCOUNT, s.id, { permissionMode: 'plan' });
    expect(planned.permissionMode).toBe('plan');
    expect(env.remembered).toHaveLength(1);
    expect(await env.svc.policy.forThread(ACCOUNT, s.threadId)).toMatchObject({
      profileId: 'read-only',
    });
    await env.svc.update(ACCOUNT, s.id, { permissionMode: 'manual', title: 'Renamed' });
    expect(env.remembered.at(-1)).toEqual({ folder: env.repo, mode: 'manual' });
    const changes = env.audit.filter((a) => a.action === 'code.mode.changed');
    expect(changes.every((a) => a.kind === 'code')).toBe(true);
    expect(changes.map((a) => a.detail)).toEqual([
      { sessionId: s.id, from: 'accept_edits', to: 'plan' },
      { sessionId: s.id, from: 'plan', to: 'manual' },
    ]);
    expect(env.events.events.filter((e) => e.name === 'code.session.modeChanged')).toHaveLength(2);
    expect((await env.svc.get(ACCOUNT, s.id)).title).toBe('Renamed');
    await expect(env.svc.update(ACCOUNT, s.id, { permissionMode: 'auto' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('falls back to Manual when the remembered mode cannot be used now', async () => {
    env = await makeCodeEnv({ values: { 'code.folderModes': {}, 'code.permissionMode': 'auto' } });
    expect((await env.svc.create(ACCOUNT, { folder: env.repo })).permissionMode).toBe('manual');
  });
});

describe('turn context and status (FR-215, docs/09 §11)', () => {
  it('adds a trusted Environment block and refreshes changes when the turn ends', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo, permissionMode: 'accept_edits' });
    const add = await env.svc.extension.forTurn({
      accountId: ACCOUNT,
      threadId: s.threadId,
      turnId: 't1',
      mode: 'code',
      trigger: 'user',
      projectId: null,
    });
    expect(add?.context?.[0]).toMatchObject({ label: 'Environment', trusted: true });
    const text = add!.context![0]!.text;
    expect(text).toContain(`Working folder: ${env.repo}`);
    expect(text).toContain('Git: branch main');
    expect(text).toContain('Accept edits');
    writeFileSync(join(env.repo, 'new.ts'), 'export const x = 1;\n');
    await add!.onEnd!({
      turnId: 't1',
      status: 'completed',
      stop: 'end',
      replyText: '',
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      activeMs: 1,
    });
    expect(env.events.events.find((e) => e.name === 'code.changes.updated')?.payload).toEqual({
      sessionId: s.id,
      files: ['new.ts'],
    });
    const chat = await env.threads.create(ACCOUNT, { mode: 'chat' });
    expect(
      await env.svc.extension.forTurn({
        accountId: ACCOUNT,
        threadId: chat.id,
        turnId: 't2',
        mode: 'chat',
        trigger: 'user',
        projectId: null,
      }),
    ).toBeNull();
  });

  it('reports a session blocked when its folder is gone', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    expect(await env.svc.status.blocked(ACCOUNT, [s.threadId])).toEqual(new Map());
    rmSync(env.repo, { recursive: true, force: true });
    expect(await env.svc.status.blocked(ACCOUNT, [s.threadId, 'other'])).toEqual(
      new Map([[s.threadId, 'Folder missing']]),
    );
    expect((await env.svc.get(ACCOUNT, s.id)).derived).toEqual({
      status: 'blocked',
      reason: 'Folder missing',
    });
    expect(await env.svc.status.children(ACCOUNT, s.threadId)).toEqual([]);
    await expect(env.svc.changes(ACCOUNT, s.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('uses the shared status when the runtime provides one', async () => {
    env = await makeCodeEnv();
    env.svc.useStatus(() => Promise.resolve({ status: 'needs_input', reason: 'Approval needed' }));
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    expect(s.derived).toEqual({ status: 'needs_input', reason: 'Approval needed' });
  });
});

describe('terminal binding (FR-066)', () => {
  it('opens a terminal in the session folder through the workspace terminals', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    await expect(env.svc.openTerminal(ACCOUNT, s.id, { cols: 80, rows: 24 })).rejects.toMatchObject(
      {
        code: 'sandbox_unavailable',
      },
    );
    const calls: unknown[] = [];
    env.svc.useTerminals({
      create: (accountId: string, input: unknown) => {
        calls.push({ accountId, input });
        return Promise.resolve({ id: 'term1' });
      },
    } as unknown as TerminalManager);
    expect(await env.svc.openTerminal(ACCOUNT, s.id, { cols: 80, rows: 24 })).toEqual({
      id: 'term1',
    });
    expect(calls).toEqual([
      { accountId: ACCOUNT, input: { threadId: s.threadId, root: env.repo, cols: 80, rows: 24 } },
    ]);
  });
});

describe('worktrees (FR-073)', () => {
  it('creates a worktree on nova/<slug> without hooks and releases it when archived', async () => {
    env = await makeCodeEnv();
    const marker = join(env.dir, 'hook-ran');
    const hook = join(env.repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`);
    chmodSync(hook, 0o755);
    const s = await env.svc.create(ACCOUNT, {
      folder: env.repo,
      worktree: true,
      title: 'Add Login',
    });
    expect(s.worktreeId).not.toBeNull();
    expect(s.folder.path).toMatch(/\/repo\/\.nova\/worktrees\/[0-9a-f]{8}$/);
    expect(s.repo?.branch).toBe('nova/add-login');
    expect(existsSync(join(s.folder.path, 'app.ts'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(await env.svc.policy.forThread(ACCOUNT, s.threadId)).toMatchObject({
      roots: [{ path: s.folder.path }],
    });
    expect(env.events.names()).toContain('worktree.leased');
    await env.threads.update(ACCOUNT, s.threadId, { archived: true });
    expect(await env.svc.sweepArchived(ACCOUNT)).toBe(1);
    expect(existsSync(s.folder.path)).toBe(false);
    expect(env.events.names()).toContain('worktree.released');
    expect(await env.svc.list(ACCOUNT)).toEqual([]);
    expect((await env.svc.list(ACCOUNT, { archived: true })).map((x) => x.id)).toEqual([s.id]);
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps a dirty worktree on release and refuses worktrees outside a repository', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo, worktree: true });
    writeFileSync(join(s.folder.path, 'wip.ts'), 'unsaved work');
    await env.threads.update(ACCOUNT, s.threadId, { archived: true });
    await env.svc.sweepArchived();
    expect(existsSync(join(s.folder.path, 'wip.ts'))).toBe(true);
    const plain = join(env.home, 'plain');
    mkdirSync(plain);
    await expect(env.svc.create(ACCOUNT, { folder: plain, worktree: true })).rejects.toMatchObject({
      code: 'validation',
    });
  });
});
