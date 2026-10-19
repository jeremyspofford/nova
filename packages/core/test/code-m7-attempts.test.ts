// Best-of-N attempts (FR-212, docs/10 §9): N attempts of one task, each its own session in its own
// worktree from the session's last commit with its own budget; the comparison shows each one's
// diff, test results and cost; applying one merges it onto the session and removes every
// attempt's worktree; discarding removes them all.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNovaError } from '@nova/shared';
import { ACCOUNT } from './helpers.ts';
import { until } from './code-m6-env.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let e: CodeM7Env;
afterEach(async () => {
  await e.close();
});

const verify = {
  'code.autoVerify': {
    enabled: true,
    commands: ['test -f ok.txt'],
    timeoutSeconds: 60,
    feedbackTurns: 0,
  },
};

describe('best-of-N attempts', () => {
  it('runs two attempts, compares them and applies one', async () => {
    e = await makeCodeM7Env({ values: verify });
    const parent = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'feature' });
    const set = await e.attempts.start(ACCOUNT, parent.id, {
      objective: 'Add ok.txt and bump a',
      count: 2,
      budgets: { costUsd: 1, timeSeconds: 600 },
    });
    expect(set.status).toBe('running');
    expect(set.attempts).toHaveLength(2);
    expect(set.baseSha).toBe(e.git(['rev-parse', 'HEAD']).trim());
    // Each attempt is its own session in its own worktree, with the user's authority.
    const [a, b] = set.attempts;
    expect(a!.worktreeId).not.toBe(b!.worktreeId);
    expect(e.turns).toHaveLength(2);
    expect(e.turns[0]!.authority).toEqual({ kind: 'user', source: `code:${parent.id}:attempts` });
    expect(e.turns[0]!.text).toContain('Add ok.txt and bump a');
    expect(a!.budget.limits).toEqual({ timeSeconds: 600, tokens: null, costUsd: 1 });
    expect(e.svc.lineage(a!.sessionId)).toEqual({ parentSessionId: parent.id, role: 'attempt' });
    // The agents work: the first adds the file the checks look for, the second does not.
    const fa = e.svc.info(ACCOUNT, a!.sessionId).folder;
    const fb = e.svc.info(ACCOUNT, b!.sessionId).folder;
    writeFileSync(join(fa, 'ok.txt'), 'ok\n');
    writeFileSync(join(fa, 'app.ts'), 'export const a = 2;\n');
    writeFileSync(join(fb, 'other.txt'), 'other\n');
    e.finishTurn(0, { replyText: 'Added ok.txt.' });
    e.finishTurn(1, { replyText: 'Added other.txt.' });
    await until(async () => (await e.attempts.get(ACCOUNT, set.id)).status === 'ready', 10_000);
    const view = await e.attempts.get(ACCOUNT, set.id);
    const [va, vb] = view.attempts;
    expect(va).toMatchObject({
      status: 'done',
      reply: 'Added ok.txt.',
      additions: 2,
      deletions: 1,
    });
    expect(va!.files.map((f) => f.path).sort()).toEqual(['app.ts', 'ok.txt']);
    expect(va!.patch).toContain('+export const a = 2;');
    expect(va!.tests?.status).toBe('passed');
    expect(vb!.files.map((f) => f.path)).toEqual(['other.txt']);
    expect(vb!.tests?.status).toBe('failed');
    expect((await e.attempts.list(ACCOUNT, parent.id)).map((x) => x.id)).toEqual([set.id]);

    const { set: applied, merge } = await e.attempts.apply(ACCOUNT, set.id, { attemptId: a!.id });
    expect(merge.status).toBe('applied');
    expect(readFileSync(join(e.repo, 'ok.txt'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(e.repo, 'app.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(existsSync(join(e.repo, 'other.txt'))).toBe(false);
    expect(applied).toMatchObject({
      status: 'applied',
      appliedAttemptId: a!.id,
      mergeId: merge.id,
    });
    expect(applied.attempts.map((x) => x.status)).toEqual(['applied', 'discarded']);
    // Every attempt's worktree is gone and its session archived.
    expect(existsSync(fa)).toBe(false);
    expect(existsSync(fb)).toBe(false);
    expect(e.svc.info(ACCOUNT, b!.sessionId).active).toBe(false);
    expect(e.git(['branch', '--list', 'nova/attempt*']).trim()).toBe('');
    // The applied work is pending in the session's review.
    expect((await e.svc.changes(ACCOUNT, parent.id)).map((c) => c.path).sort()).toEqual([
      'app.ts',
      'ok.txt',
    ]);
    expect(e.audit.map((x) => x.action)).toEqual(
      expect.arrayContaining(['code.attempts.started', 'code.attempt.applied', 'code.merge']),
    );
    await expect(e.attempts.apply(ACCOUNT, set.id, { attemptId: b!.id })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('discards attempts and refuses what it cannot run', async () => {
    e = await makeCodeM7Env();
    const parent = await e.svc.create(ACCOUNT, { folder: e.repo });
    const set = await e.attempts.start(ACCOUNT, parent.id, { objective: 'try things' });
    // The default count comes from `code.attempts` (2).
    expect(set.attempts).toHaveLength(2);
    expect(set.attempts[0]!.budget.limits.timeSeconds).toBe(1800);
    const folders = set.attempts.map((x) => e.svc.info(ACCOUNT, x.sessionId).folder);
    const gone = await e.attempts.discard(ACCOUNT, set.id);
    expect(gone.status).toBe('discarded');
    expect(gone.attempts.every((x) => x.status === 'discarded')).toBe(true);
    for (const f of folders) expect(existsSync(f)).toBe(false);
    expect(e.audit.some((x) => x.action === 'code.attempts.discarded')).toBe(true);
    await expect(
      e.attempts.start(ACCOUNT, parent.id, { objective: 'x', count: 5 }),
    ).rejects.toThrow();
    // Attempts need worktrees: a session on another machine cannot have them.
    const ssh = await e.sshEnv();
    const remote = await e.svc.create(ACCOUNT, { folder: e.clone('box'), environmentId: ssh });
    try {
      await e.attempts.start(ACCOUNT, remote.id, { objective: 'x' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isNovaError(err) && err.code).toBe('capability_missing');
    }
  });
  it('runs no checks when auto-verify is off', async () => {
    e = await makeCodeM7Env({
      values: { 'code.autoVerify': { ...verify['code.autoVerify'], enabled: false } },
    });
    const parent = await e.svc.create(ACCOUNT, { folder: e.repo });
    const set = await e.attempts.start(ACCOUNT, parent.id, { objective: 'quiet', count: 2 });
    e.finishTurn(0, { replyText: 'a' });
    e.finishTurn(1, { replyText: 'b' });
    await until(async () => (await e.attempts.get(ACCOUNT, set.id)).status === 'ready', 10_000);
    const view = await e.attempts.get(ACCOUNT, set.id);
    expect(view.attempts.map((x) => x.tests)).toEqual([null, null]);
    expect(e.events.events.some((x) => x.name === 'code.verify.started')).toBe(false);
  });
});
