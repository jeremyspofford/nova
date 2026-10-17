// Auto-verify (FR-068, docs/10 §7, §14): after a turn edits files the project's checks run in the
// sandbox (network off) and report pass or fail with logs; failures go back to the agent as a
// turn without authority, at most `feedbackTurns` in a row; budgets of Code sessions (docs/09 §2).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectVerifyCommands, type TurnOutcome } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { SessionSandbox, makeCodeM6Env, until, type CodeM6Env } from './code-m6-env.ts';

let e: CodeM6Env;
afterEach(async () => {
  await e.close();
});

const done: TurnOutcome = {
  turnId: 'x',
  status: 'completed',
  stop: 'end',
  replyText: '',
  steps: 1,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  activeMs: 5,
};

/** One turn of a session: optionally edit a file before it ends. */
async function turn(threadId: string, turnId: string, edit?: () => void, outcome = done) {
  const ext = await e.svc.extension.forTurn({
    accountId: ACCOUNT,
    threadId,
    turnId,
    mode: 'code',
    trigger: 'user',
    projectId: null,
  });
  edit?.();
  await ext!.onEnd!({ ...outcome, turnId });
  return ext!;
}

describe('auto-verify', () => {
  it('detects build and test commands', async () => {
    e = await makeCodeM6Env();
    writeFileSync(
      join(e.repo, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', build: 'vite build', test: 'vitest' } }),
    );
    expect(await detectVerifyCommands(e.repo)).toEqual([
      { name: 'typecheck', command: 'npm run typecheck' },
      { name: 'test', command: 'npm test' },
    ]);
    writeFileSync(join(e.home, 'go.mod'), 'module x\n');
    expect((await detectVerifyCommands(e.home)).map((c) => c.command)).toEqual([
      'go build ./...',
      'go test ./...',
    ]);
  });

  it('runs the checks after a turn that edited files and sends failures back once', async () => {
    e = await makeCodeM6Env({
      values: {
        'code.autoVerify': {
          enabled: true,
          commands: ['echo build ok', 'echo "expected 1, got 2" >&2; exit 3'],
          timeoutSeconds: 60,
          feedbackTurns: 1,
        },
      },
    });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    // A turn that changed nothing runs nothing.
    await turn(s.threadId, 'user-1');
    expect(e.verifier.list(ACCOUNT, s.id)).toEqual([]);
    await turn(s.threadId, 'user-2', () =>
      writeFileSync(join(e.repo, 'app.ts'), 'export const a = 2;\n'),
    );
    await until(() => e.verifier.list(ACCOUNT, s.id)[0]?.status === 'failed');
    const run = e.verifier.list(ACCOUNT, s.id)[0]!;
    expect(run.trigger).toBe('auto');
    expect(run.checks.map((c) => [c.status, c.exitCode])).toEqual([
      ['passed', 0],
      ['failed', 3],
    ]);
    expect(run.checks[1]!.log).toContain('expected 1, got 2');
    expect(e.events.events.find((x) => x.name === 'code.verify.completed')?.payload).toMatchObject({
      sessionId: s.id,
      status: 'failed',
    });
    await until(() => e.turns.length === 1);
    expect(e.turns[0]).toMatchObject({
      threadId: s.threadId,
      trigger: 'event',
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
    expect(e.turns[0]!.text).toContain('expected 1, got 2');
    // The feedback turn edits again and fails again: no second feedback in a row.
    await turn(s.threadId, 'turn-1', () =>
      writeFileSync(join(e.repo, 'app.ts'), 'export const a = 3;\n'),
    );
    await until(
      () =>
        e.verifier.list(ACCOUNT, s.id).length === 2 &&
        e.verifier.list(ACCOUNT, s.id)[0]!.status !== 'running',
    );
    expect(e.turns).toHaveLength(1);
    // The user's next turn starts the count again.
    await turn(s.threadId, 'user-3', () =>
      writeFileSync(join(e.repo, 'app.ts'), 'export const a = 4;\n'),
    );
    await until(() => e.turns.length === 2);
  });

  it('runs on request, passes, and is skipped without checks or a sandbox', async () => {
    e = await makeCodeM6Env({
      values: {
        'code.autoVerify': {
          enabled: true,
          commands: ['true'],
          timeoutSeconds: 60,
          feedbackTurns: 1,
        },
      },
    });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const { view, done: finished } = await e.verifier.run(ACCOUNT, s.id);
    expect(view).toMatchObject({ status: 'running', trigger: 'manual' });
    await expect(e.verifier.run(ACCOUNT, s.id)).rejects.toThrow(/already running/);
    expect((await finished).status).toBe('passed');
    expect(e.verifier.get(ACCOUNT, s.id, view.id).status).toBe('passed');
    e.sandbox.current = null;
    expect((await (await e.verifier.run(ACCOUNT, s.id)).done).status).toBe('skipped');
    e.values['code.autoVerify'] = {
      enabled: true,
      commands: [],
      timeoutSeconds: 60,
      feedbackTurns: 1,
    };
    e.sandbox.current = new SessionSandbox();
    const none = await (await e.verifier.run(ACCOUNT, s.id)).done;
    expect(none.status).toBe('skipped');
    expect(none.checks[0]!.log).toContain('no build or test command');
  });

  it('stops a check that runs past its time', async () => {
    const box = new SessionSandbox();
    e = await makeCodeM6Env({
      sandbox: box,
      values: {
        'code.autoVerify': {
          enabled: true,
          commands: ['sleep 20'],
          timeoutSeconds: 1,
          feedbackTurns: 0,
        },
      },
    });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const r = await (await e.verifier.run(ACCOUNT, s.id)).done;
    expect(r.status).toBe('failed');
    expect(r.checks[0]!.status).toBe('timeout');
    // The command was terminated.
    await until(() => [...box.sessions.values()].every((x) => x.exitCode !== null));
  });

  it('does not run when disabled', async () => {
    e = await makeCodeM6Env({
      values: {
        'code.autoVerify': {
          enabled: false,
          commands: ['true'],
          timeoutSeconds: 60,
          feedbackTurns: 1,
        },
      },
    });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    await turn(s.threadId, 'u1', () => writeFileSync(join(e.repo, 'new.ts'), 'x\n'));
    await new Promise((r) => setTimeout(r, 50));
    expect(e.verifier.list(ACCOUNT, s.id)).toEqual([]);
  });
});

describe('session budgets', () => {
  it('bounds turns by the session budget and extends it', async () => {
    e = await makeCodeM6Env();
    const s = await e.svc.create(ACCOUNT, {
      folder: e.repo,
      budgets: { tokens: 1_000, timeSeconds: null },
    });
    const ext = await e.svc.extension.forTurn({
      accountId: ACCOUNT,
      threadId: s.threadId,
      turnId: 'b1',
      mode: 'code',
      trigger: 'user',
      projectId: null,
    });
    expect(ext!.bounds!.check()).toBeNull();
    ext!.bounds!.record({ inputTokens: 700, outputTokens: 400, costUsd: 0.01, activeMs: 2_000 });
    await until(() => e.svc.budget(ACCOUNT, s.id).used.tokens === 1_100);
    expect(ext!.bounds!.check()).toEqual({ bound: 'tokens', used: 1_100, limit: 1_000 });
    await ext!.onEnd!({
      ...done,
      turnId: 'b1',
      stop: 'budget',
      bound: { bound: 'tokens', used: 1_100, limit: 1_000 },
    });
    expect(e.svc.budget(ACCOUNT, s.id)).toMatchObject({
      limits: { tokens: 1_000, timeSeconds: null, costUsd: null },
      used: { tokens: 1_100, timeSeconds: 2 },
      reached: 'tokens',
    });
    const ext2 = await e.svc.extension.forTurn({
      accountId: ACCOUNT,
      threadId: s.threadId,
      turnId: 'b2',
      mode: 'code',
      trigger: 'user',
      projectId: null,
    });
    expect(ext2!.context![0]!.text).toContain('Budget left: 0 tokens');
    const more = await e.svc.extendBudget(ACCOUNT, s.id, { tokens: 5_000 });
    expect(more).toMatchObject({ limits: { tokens: 6_000 }, reached: null });
    expect(ext2!.bounds!.check()).toBeNull();
    // A session without a cost cap gets one from what it used.
    const cost = await e.svc.extendBudget(ACCOUNT, s.id, { costUsd: 1 });
    expect(cost.limits.costUsd).toBeCloseTo(1.01);
    expect(e.audit.filter((a) => a.action === 'code.budget.extended')).toHaveLength(2);
  });

  it('uses the default budget setting and has none by default', async () => {
    e = await makeCodeM6Env({
      values: { 'code.budgets': { timeSeconds: 600, tokens: null, costUsd: null } },
    });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    expect(e.svc.budget(ACCOUNT, s.id).limits).toEqual({
      timeSeconds: 600,
      tokens: null,
      costUsd: null,
    });
    const t = await e.svc.extension.forTurn({
      accountId: ACCOUNT,
      threadId: s.threadId,
      turnId: 't',
      mode: 'code',
      trigger: 'user',
      projectId: null,
    });
    t!.bounds!.record({ inputTokens: 1, outputTokens: 1, costUsd: 0, activeMs: 601_000 });
    await until(() => t!.bounds!.check()?.bound === 'time');
  });
});
