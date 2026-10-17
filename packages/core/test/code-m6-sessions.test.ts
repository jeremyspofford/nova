// Cross-session operations (FR-072, docs/10 §10), workers in their own worktrees (FR-073,
// `task.spawn(role='coder', worktree=true)`), and the M6 coding tools: which threads get them and
// what their handlers do (git.branch, git.commit, pr.create's guard, devserver.list).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  MAX_ACTIVE_WORKERS,
  codeAreaToolSource,
  codeM6Tools,
  codeTools,
  type BuiltinTool,
  type ToolContext,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { makeCodeM6Env, type CodeM6Env } from './code-m6-env.ts';

let e: CodeM6Env;
afterEach(async () => {
  await e.close();
});

function ctx(threadId: string): ToolContext {
  return {
    accountId: ACCOUNT,
    threadId,
    turnId: 'turn-x',
    callId: 'call-x',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: e.sandbox.current!,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
  };
}

function tools(): Map<string, BuiltinTool> {
  const m6 = codeM6Tools({ code: e.svc, prs: e.prs, devServers: e.devServers, ops: e.ops });
  return new Map([...m6.code, ...m6.sessions].map((t) => [t.descriptor.name, t]));
}

function text(r: { ok: boolean; content?: { type: string; text?: string }[] }): string {
  return (r.content ?? []).map((c) => c.text ?? '').join('');
}

describe('cross-session operations', () => {
  it('lists other sessions, messages one without authority, and archives one', async () => {
    e = await makeCodeM6Env();
    const a = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'A' });
    const b = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'B', worktree: true });
    const listed = e.ops.list(ACCOUNT, a.threadId);
    expect(listed.map((x) => x.title)).toEqual(['B']);
    expect(e.ops.list(ACCOUNT, null)).toHaveLength(2);
    const sent = await e.ops.message(ACCOUNT, a.threadId, b.id, 'Please rebase on main.');
    expect(sent.sessionId).toBe(b.id);
    expect(e.turns[0]).toMatchObject({
      threadId: b.threadId,
      trigger: 'event',
      triggerRef: `session:${a.id}`,
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
    expect(e.turns[0]!.text).toContain('Message from the Code session "A"');
    expect(e.turns[0]!.text).toContain('Please rebase on main.');
    expect(e.audit.find((x) => x.action === 'code.session.messaged')).toMatchObject({
      actor: 'agent',
      detail: { toSessionId: b.id, fromSessionId: a.id },
    });
    await expect(e.ops.message(ACCOUNT, a.threadId, a.id, 'me')).rejects.toThrow(/this session/);
    await e.ops.archive(ACCOUNT, a.threadId, b.id);
    const after = await e.svc.list(ACCOUNT, { archived: true });
    expect(after.map((x) => x.id)).toEqual([b.id]);
    expect((await e.svc.worktrees.view(ACCOUNT, b.worktreeId!)).status).toBe('removed');
    await expect(e.ops.message(ACCOUNT, a.threadId, b.id, 'hi')).rejects.toThrow(/archived/);
    // An agent thread (not a session) may message a session too.
    await e.ops.message(ACCOUNT, 'agent-thread', a.id, 'status?');
    expect(e.turns.at(-1)!.text).toContain('an agent of this account');
  });

  it("answers a side question from another session's context without adding a turn", async () => {
    e = await makeCodeM6Env();
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'Login fix' });
    const before = (await e.threads.detail(ACCOUNT, s.threadId)).messages.length;
    const r = await e.ops.ask(ACCOUNT, s.id, 'Which branch is it on?');
    // The mock model echoes the prompt it got: the session facts and the question.
    expect(r.answer).toContain('Session: Login fix');
    expect(r.answer).toContain('Which branch is it on?');
    expect(r.model).toBeTruthy();
    expect((await e.threads.detail(ACCOUNT, s.threadId)).messages).toHaveLength(before);
  });
});

describe('workers (task.spawn)', () => {
  it("starts a worker session in its own worktree from the parent's commit and collects its result", async () => {
    e = await makeCodeM6Env();
    const parent = await e.svc.create(ACCOUNT, {
      folder: e.repo,
      title: 'parent',
      permissionMode: 'accept_edits',
    });
    writeFileSync(join(e.repo, 'wip.ts'), 'uncommitted\n');
    const head = e.git(['rev-parse', 'HEAD']).trim();
    const w = await e.ops.spawnWorker(ACCOUNT, parent.threadId, {
      role: 'coder',
      objective: 'Add input validation to the login form',
    });
    const child = await e.svc.get(ACCOUNT, w.sessionId);
    expect(child.worktreeId).toBe(w.worktreeId);
    expect(child.permissionMode).toBe('accept_edits');
    expect(w.branch).toMatch(/^nova\/coder-add-input-validation/);
    expect(e.git(['rev-parse', 'HEAD'], child.folder.path).trim()).toBe(head);
    expect(e.svc.lineage(w.sessionId)).toEqual({ parentSessionId: parent.id, role: 'coder' });
    expect(e.turns[0]).toMatchObject({
      threadId: w.threadId,
      authority: { kind: 'none', origin: 'system' },
      authorKind: 'subagent',
      triggerRef: parent.id,
    });
    expect(e.turns[0]!.text).toContain('Add input validation');
    expect(e.ops.list(ACCOUNT, parent.threadId)[0]).toMatchObject({
      id: w.sessionId,
      parentSessionId: parent.id,
      role: 'coder',
    });
    const waiting = await e.ops.waitWorkers(
      ACCOUNT,
      parent.threadId,
      [w.sessionId],
      20,
      new AbortController().signal,
    );
    expect(waiting).toMatchObject({ done: false, results: [{ status: 'running' }] });
    e.finishTurn(0);
    const finished = await e.ops.waitWorkers(
      ACCOUNT,
      parent.threadId,
      [],
      2_000,
      new AbortController().signal,
    );
    expect(finished.done).toBe(true);
    expect(finished.results[0]).toMatchObject({ id: w.sessionId, role: 'coder', status: 'done' });
    await expect(
      e.ops.waitWorkers(ACCOUNT, parent.threadId, ['nope'], 10, new AbortController().signal),
    ).rejects.toThrow(/no workers/);
  });

  it('runs at most four workers at once and only from Code sessions', async () => {
    e = await makeCodeM6Env();
    const parent = await e.svc.create(ACCOUNT, { folder: e.repo });
    for (let i = 0; i < MAX_ACTIVE_WORKERS; i++)
      await e.ops.spawnWorker(ACCOUNT, parent.threadId, { role: 'coder', objective: `task ${i}` });
    await expect(
      e.ops.spawnWorker(ACCOUNT, parent.threadId, { role: 'coder', objective: 'one more' }),
    ).rejects.toThrow(/at most 4/);
    await expect(
      e.ops.spawnWorker(ACCOUNT, 'not-a-code-thread', { role: 'coder', objective: 'x' }),
    ).rejects.toThrow(/only in Code sessions/);
  });
});

describe('M6 coding tools', () => {
  it('are offered in Code threads, the session tools in agent threads, and nothing elsewhere', async () => {
    e = await makeCodeM6Env();
    const m6 = codeM6Tools({ code: e.svc, prs: e.prs, devServers: e.devServers, ops: e.ops });
    const source = codeAreaToolSource(codeTools(e.svc), m6);
    const names = async (mode?: 'chat' | 'work' | 'code' | 'agent') =>
      (await source.list(ACCOUNT, mode ? { threadId: 't', mode } : undefined)).map(
        (t) => t.descriptor.name,
      );
    const code = await names('code');
    expect(code).toEqual(
      expect.arrayContaining([
        'git.status',
        'git.branch',
        'git.commit',
        'pr.create',
        'pr.status',
        'devserver.start',
        'task.spawn',
        'task.wait',
        'sessions.message',
      ]),
    );
    expect(await names('agent')).toEqual([
      'sessions.list',
      'sessions.message',
      'sessions.archive',
      'sessions.ask',
    ]);
    expect(await names('chat')).toEqual([]);
    expect(await names('work')).toEqual([]);
    const all = await names();
    expect(all).toContain('pr.create');
    expect(all).not.toContain('task.spawn');
    // Annotations the gate reads: messaging and committing are actions, listing is a read.
    const t = tools();
    expect(t.get('sessions.message')!.descriptor.annotations).toMatchObject({ action: 'write' });
    expect(t.get('sessions.list')!.descriptor.annotations).toMatchObject({ readOnly: true });
    expect(t.get('pr.create')!.descriptor.annotations).toMatchObject({ action: 'send' });
    expect(t.get('devserver.start')!.descriptor.effects).toEqual(['exec']);
  });

  it('create a branch and commit what the user accepted', async () => {
    e = await makeCodeM6Env();
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const t = tools();
    const c = ctx(s.threadId);
    // On main the agent's commit is refused: it must branch first.
    writeFileSync(join(e.repo, 'app.ts'), 'export const a = 42;\n');
    await e.svc.decideAll(ACCOUNT, s.id, true);
    const refused = await t.get('git.commit')!.handler({ message: 'Change a' }, c);
    expect(refused).toMatchObject({ ok: false, error: { code: 'default_branch' } });
    const branched = await t.get('git.branch')!.handler({ name: 'Answer Everything' }, c);
    expect(text(branched)).toContain('nova/answer-everything');
    expect((await e.svc.get(ACCOUNT, s.id)).repo?.branch).toBe('nova/answer-everything');
    const committed = await t.get('git.commit')!.handler({ message: 'Change a' }, c);
    expect(committed.ok).toBe(true);
    expect(e.git(['log', '-1', '--format=%s'])).toContain('Change a');
    expect(e.audit.find((a) => a.action === 'code.commit')?.actor).toBe('agent');
    expect(e.audit.find((a) => a.action === 'code.branch.created')?.actor).toBe('agent');
    // pr.create reports why it cannot push (the push guards are in code-m6-pr.test.ts).
    const pr = await t.get('pr.create')!.handler({ title: 'x' }, c);
    expect(pr).toMatchObject({ ok: false, error: { code: 'no_remote' } });
    expect(text(await t.get('pr.status')!.handler({}, c))).toContain('no pull request');
    // Outside a Code session the tools say they do not apply.
    expect(await t.get('git.branch')!.handler({ name: 'x' }, ctx('chat-thread'))).toMatchObject({
      ok: false,
      error: { code: 'not_available' },
    });
  });

  it('list dev servers and talk to other sessions through the tool handlers', async () => {
    e = await makeCodeM6Env();
    writeFileSync(join(e.repo, 'manage.py'), '');
    const a = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'A' });
    const b = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'B' });
    const t = tools();
    const listing = text(await t.get('devserver.list')!.handler({}, ctx(a.threadId)));
    expect(listing).toContain('django: Django');
    expect(await t.get('devserver.stop')!.handler({}, ctx(a.threadId))).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    const others = JSON.parse(text(await t.get('sessions.list')!.handler({}, ctx(a.threadId)))) as {
      id: string;
    }[];
    expect(others.map((x) => x.id)).toEqual([b.id]);
    const sent = await t
      .get('sessions.message')!
      .handler({ sessionId: b.id, text: 'hi' }, ctx(a.threadId));
    expect(sent.ok).toBe(true);
    const asked = await t
      .get('sessions.ask')!
      .handler({ sessionId: b.id, question: 'What?' }, ctx(a.threadId));
    expect(text(asked)).toContain('Question: What?');
    const arch = await t.get('sessions.archive')!.handler({ sessionId: b.id }, ctx(a.threadId));
    expect(arch.ok).toBe(true);
    const spawn = await t
      .get('task.spawn')!
      .handler({ role: 'coder', objective: 'x' }, ctx(a.threadId));
    expect(spawn.ok).toBe(true);
    const wait = await t
      .get('task.wait')!
      .handler({ timeoutSeconds: 10 }, { ...ctx(a.threadId), signal: AbortSignal.abort() });
    expect(JSON.parse(text(wait))).toMatchObject({ done: false });
  });
});
