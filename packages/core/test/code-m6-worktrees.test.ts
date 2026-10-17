// The worktree registry (FR-073, docs/10 §9): worktrees with leases (create, lease to a session,
// renew, release, remove), `.worktreeinclude` copying ignored files but never protected or
// credential locations, at most 15 per repository with the offer to remove the oldest unleased
// clean one, sessions bound to a registry worktree, expiry, and cleanup on archive.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNovaError, type WorktreeView } from '@nova/shared';
import { MAX_WORKTREES_PER_REPO } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { makeCodeM6Env, type CodeM6Env } from './code-m6-env.ts';

let e: CodeM6Env;
afterEach(async () => {
  await e.close();
});

async function failure(
  p: Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) return { code: err.code, details: err.details ?? {} };
    throw err;
  }
  throw new Error('expected a failure');
}

describe('worktree registry', () => {
  it('copies .worktreeinclude files that are ignored, never protected or credential ones', async () => {
    e = await makeCodeM6Env();
    writeFileSync(join(e.repo, '.env'), 'API_URL=http://localhost\n');
    writeFileSync(join(e.repo, '.env.local'), 'DEBUG=1\n');
    mkdirSync(join(e.repo, 'secrets'));
    writeFileSync(join(e.repo, 'secrets', 'notes.txt'), 'n');
    writeFileSync(join(e.repo, 'untracked.txt'), 'not ignored');
    writeFileSync(join(e.repo, '.git-credentials'), 'https://u:p@example.invalid');
    writeFileSync(join(e.repo, '.gitignore'), 'dist/\n.env\n.env.*\nsecrets/\n.git-credentials\n');
    writeFileSync(
      join(e.repo, '.worktreeinclude'),
      '.env\n.env.*\nuntracked.txt\n.git-credentials\n!.env.local\n',
    );
    const w = await e.svc.createWorktree(ACCOUNT, { repo: e.repo });
    expect(w).toMatchObject({ leasedBy: null, status: 'active', included: 1, dirty: false });
    expect(w.branch).toBe('nova/repo');
    expect(w.path).toBe(join(e.repo, '.nova', 'worktrees', w.name));
    expect(readFileSync(join(w.path, '.env'), 'utf8')).toContain('API_URL');
    // A negation, a file the repository does not ignore and a credential location stay out.
    expect(existsSync(join(w.path, '.env.local'))).toBe(false);
    expect(existsSync(join(w.path, 'untracked.txt'))).toBe(false);
    expect(existsSync(join(w.path, '.git-credentials'))).toBe(false);
    expect(existsSync(join(w.path, 'secrets'))).toBe(false);
    expect(e.audit.find((a) => a.action === 'code.worktree.created')?.detail).toMatchObject({
      included: 1,
    });
  });

  it('leases to a session, renews, releases and removes with the guards', async () => {
    let clock = new Date('2026-10-17T10:00:00.000Z');
    e = await makeCodeM6Env({ now: () => clock });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'parent' });
    const w = await e.svc.createWorktree(ACCOUNT, {
      repo: e.repo,
      sessionId: s.id,
      branch: 'Fix Login',
      ttlMinutes: 30,
    });
    expect(w).toMatchObject({ leasedBy: s.id, leaseExpiresAt: '2026-10-17T10:30:00.000Z' });
    expect(w.branch).toBe('nova/fix-login');
    expect(e.events.events.find((x) => x.name === 'worktree.leased')?.payload).toMatchObject({
      worktreeId: w.id,
      sessionId: s.id,
      expiresAt: '2026-10-17T10:30:00.000Z',
    });
    // A leased worktree is not removed, nor bound to another session.
    expect((await failure(e.svc.worktrees.remove(ACCOUNT, w.id))).details.reason).toBe('leased');
    expect(
      (await failure(e.svc.create(ACCOUNT, { folder: e.repo, worktreeId: w.id }))).details.reason,
    ).toBe('leased');
    const renewed = await e.svc.worktrees.renew(ACCOUNT, w.id, 120);
    expect(renewed.leaseExpiresAt).toBe('2026-10-17T12:00:00.000Z');
    // Past its end the lease is released by the sweep; the worktree stays.
    clock = new Date('2026-10-17T12:01:00.000Z');
    expect(await e.svc.worktrees.sweepExpired()).toBe(1);
    const after = await e.svc.worktrees.view(ACCOUNT, w.id);
    expect(after).toMatchObject({ leasedBy: null, status: 'released' });
    expect(e.events.events.find((x) => x.name === 'worktree.released')?.payload).toMatchObject({
      worktreeId: w.id,
      reason: 'expired',
    });
    expect((await failure(e.svc.worktrees.renew(ACCOUNT, w.id))).details.reason).toBe('not_leased');
    // A dirty worktree is removed only with force.
    writeFileSync(join(w.path, 'wip.ts'), 'export const wip = 1;\n');
    expect((await failure(e.svc.worktrees.remove(ACCOUNT, w.id))).details.reason).toBe('dirty');
    const removed = await e.svc.worktrees.remove(ACCOUNT, w.id, true);
    expect(removed.status).toBe('removed');
    expect(existsSync(w.path)).toBe(false);
    // The branch stays.
    expect(e.git(['branch', '--list', 'nova/fix-login'])).toContain('nova/fix-login');
  });

  it('binds a session to a registry worktree and refuses to release it while the session works there', async () => {
    e = await makeCodeM6Env();
    const w = await e.svc.createWorktree(ACCOUNT, { repo: e.repo });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, worktreeId: w.id });
    expect(s.worktreeId).toBe(w.id);
    expect(s.folder.path).toBe(w.path);
    expect((await e.svc.worktrees.view(ACCOUNT, w.id)).leasedBy).toBe(s.id);
    expect((await failure(e.svc.worktrees.release(ACCOUNT, w.id))).details.reason).toBe('in_use');
    expect((await failure(e.svc.worktrees.remove(ACCOUNT, w.id))).details.reason).toBe('in_use');
    // Archiving the session removes the clean worktree (code.worktreeCleanup: remove_clean).
    await e.svc.archive(ACCOUNT, s.id);
    expect((await e.svc.worktrees.view(ACCOUNT, w.id)).status).toBe('removed');
    expect(existsSync(w.path)).toBe(false);
  });

  it('keeps a clean worktree on archive when the cleanup setting says keep', async () => {
    e = await makeCodeM6Env({ values: { 'code.worktreeCleanup': 'keep' } });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, worktree: true });
    const wid = s.worktreeId!;
    await e.svc.archive(ACCOUNT, s.id);
    const v = await e.svc.worktrees.view(ACCOUNT, wid);
    expect(v).toMatchObject({ status: 'released', leasedBy: null });
    expect(existsSync(v.path)).toBe(true);
    // Released and unleased: now it can be removed.
    expect((await e.svc.worktrees.remove(ACCOUNT, wid)).status).toBe('removed');
  });

  it('releases the leases an archived session held for its workers', async () => {
    e = await makeCodeM6Env();
    const parent = await e.svc.create(ACCOUNT, { folder: e.repo });
    const w = await e.svc.createWorktree(ACCOUNT, { repo: e.repo, sessionId: parent.id });
    await e.svc.archive(ACCOUNT, parent.id);
    expect((await e.svc.worktrees.view(ACCOUNT, w.id)).leasedBy).toBeNull();
    await expect(
      e.svc.createWorktree(ACCOUNT, { repo: e.repo, sessionId: parent.id }),
    ).rejects.toThrow(/archived/);
  });

  it('keeps at most 15 worktrees per repository and removes the oldest clean unleased one only on request', async () => {
    e = await makeCodeM6Env();
    const made: WorktreeView[] = [];
    for (let i = 0; i < MAX_WORKTREES_PER_REPO; i++)
      made.push(await e.svc.createWorktree(ACCOUNT, { repo: e.repo, branch: `w${i}` }));
    // The oldest is dirty, the second is leased: the third is the oldest removable one.
    writeFileSync(join(made[0]!.path, 'dirty.txt'), 'x');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, worktreeId: made[1]!.id });
    const cap = await failure(e.svc.createWorktree(ACCOUNT, { repo: e.repo }));
    expect(cap.code).toBe('conflict');
    expect(cap.details.reason).toBe('worktree_cap');
    expect(cap.details.unleased).toHaveLength(MAX_WORKTREES_PER_REPO - 1);
    expect((cap.details.removable as string[])[0]).toBe(made[2]!.id);
    // A session asking for a new worktree gets the same refusal.
    expect(
      (await failure(e.svc.create(ACCOUNT, { folder: e.repo, worktree: true }))).details.reason,
    ).toBe('worktree_cap');
    const next = await e.svc.createWorktree(ACCOUNT, { repo: e.repo, removeOldest: true });
    expect(next.status).toBe('active');
    expect((await e.svc.worktrees.view(ACCOUNT, made[2]!.id)).status).toBe('removed');
    expect((await e.svc.worktrees.view(ACCOUNT, made[0]!.id)).status).toBe('active');
    expect(s.worktreeId).toBe(made[1]!.id);
    const listed = await e.svc.listWorktrees(ACCOUNT, { repo: e.repo });
    expect(listed).toHaveLength(MAX_WORKTREES_PER_REPO);
    expect(listed.find((x) => x.id === made[0]!.id)?.dirty).toBe(true);
    expect((await e.svc.listWorktrees(ACCOUNT, { status: 'removed' })).map((x) => x.id)).toEqual([
      made[2]!.id,
    ]);
  }, 30_000);

  it('refuses a worktree outside Git, before the first commit and for another account', async () => {
    e = await makeCodeM6Env();
    const plain = join(e.home, 'plain');
    mkdirSync(plain);
    await expect(e.svc.createWorktree(ACCOUNT, { repo: plain })).rejects.toThrow(/Git repository/);
    const fresh = join(e.home, 'fresh');
    mkdirSync(fresh);
    e.git(['init', '-q', '-b', 'main'], fresh);
    await expect(e.svc.createWorktree(ACCOUNT, { repo: fresh })).rejects.toThrow(
      /first commit|at least one commit/,
    );
    const w = await e.svc.createWorktree(ACCOUNT, { repo: e.repo });
    await expect(e.svc.worktrees.view('someone-else', w.id)).rejects.toThrow(/not found/);
  });
});
