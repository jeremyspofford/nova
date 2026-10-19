// Session handoff (FR-213, docs/10 §15): a session moves with its branch, local commits (a
// bundle through the Hub) and every uncommitted change (text, binary, new, deleted) to another
// environment or worktree; the target confirms HEAD and the working-state tree before the session
// moves; refusals leave the target as it was and the session where it was; the move waits for the
// running turn, holds the next one, and is recorded in the session history.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionHandoffView } from '@nova/shared';
import { ACCOUNT } from './helpers.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let e: CodeM7Env;
afterEach(async () => {
  await e.close();
});

const BINARY = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7) % 256));

async function handoff(
  sessionId: string,
  body: Parameters<CodeM7Env['handoffs']['start']>[2],
): Promise<SessionHandoffView> {
  const { view, done } = await e.handoffs.start(ACCOUNT, sessionId, body);
  expect(view.status).toBe('pending');
  return done;
}

/** No uncommitted change (Nova's own worktrees under `.nova/` aside). */
function clean(dir: string): boolean {
  return e.gitIn(dir, ['status', '--porcelain', '--', '.', ':!.nova']).trim() === '';
}

function threadState(threadId: string, state: 'streaming' | 'idle'): void {
  e.db.raw.prepare('UPDATE thread SET state = ? WHERE id = ?').run(state, threadId);
}

describe('session handoff', () => {
  it('moves a session to an SSH host and back with its commits and uncommitted changes', async () => {
    e = await makeCodeM7Env();
    const box = e.clone('box');
    const ssh = await e.sshEnv();
    const local = (await e.svc.envs.local(ACCOUNT)).id;
    // A local commit no remote has, then uncommitted work of every kind.
    e.git(['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(e.repo, 'lib.ts'), 'export const lib = 1;\n');
    writeFileSync(join(e.repo, 'old.txt'), 'old\n');
    e.git(['add', '-A']);
    e.git(['commit', '-q', '-m', 'lib']);
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    writeFileSync(join(e.repo, 'app.ts'), 'export const a = 42;\n');
    writeFileSync(join(e.repo, 'logo.bin'), BINARY);
    writeFileSync(join(e.repo, 'notes.md'), '# notes\n');
    unlinkSync(join(e.repo, 'old.txt'));
    const head = e.git(['rev-parse', 'HEAD']).trim();

    const there = await handoff(s.id, { to: { environmentId: ssh, folder: box } });
    expect(there).toMatchObject({ status: 'completed', reason: null, source: 'keep', folder: box });
    expect(there.git).toMatchObject({ branch: 'feature', head, files: 4, bundleCommits: 1 });
    expect(there.git?.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    // The target continues on the same branch with the patch applied, byte for byte.
    expect(e.gitIn(box, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(e.gitIn(box, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
    expect(readFileSync(join(box, 'app.ts'), 'utf8')).toBe('export const a = 42;\n');
    expect(readFileSync(join(box, 'logo.bin')).equals(BINARY)).toBe(true);
    expect(existsSync(join(box, 'old.txt'))).toBe(false);
    expect(readFileSync(join(box, 'notes.md'), 'utf8')).toBe('# notes\n');
    // No temporary ref is left behind there.
    expect(e.gitIn(box, ['for-each-ref', 'refs/nova']).trim()).toBe('');
    // The session moved; its review restarts there with every traveled change pending.
    const moved = e.svc.info(ACCOUNT, s.id);
    expect(moved).toMatchObject({
      environmentId: ssh,
      folder: box,
      hubLocal: false,
      branch: 'feature',
    });
    const changes = await e.svc.changes(ACCOUNT, s.id);
    expect(changes.map((c) => c.path).sort()).toEqual([
      'app.ts',
      'logo.bin',
      'notes.md',
      'old.txt',
    ]);
    // The source was kept.
    expect(readFileSync(join(e.repo, 'app.ts'), 'utf8')).toBe('export const a = 42;\n');
    // History, events and audit.
    expect(e.handoffs.list(ACCOUNT, s.id).map((h) => h.id)).toEqual([there.id]);
    expect(e.handoffs.get(ACCOUNT, there.id).status).toBe('completed');
    const statuses = e.events.events
      .filter((x) => x.name === 'session.handedOff')
      .map((x) => (x.payload as { status: string }).status);
    expect(statuses).toEqual(['pending', 'running', 'completed']);
    expect(e.audit.find((a) => a.action === 'code.handoff.completed')?.detail).toMatchObject({
      handoffId: there.id,
      stateHash: there.git?.stateHash,
    });

    // Back to the Hub: refused while the Hub's checkout still has the kept changes.
    const refused = await handoff(s.id, {
      to: { environmentId: local, folder: e.repo },
      source: 'clean',
    });
    expect(refused).toMatchObject({ status: 'refused', reason: 'target_dirty' });
    expect(e.svc.info(ACCOUNT, s.id).environmentId).toBe(ssh);
    expect(e.audit.some((a) => a.action === 'code.handoff.refused')).toBe(true);
    e.git(['checkout', '-q', '--', '.']);
    e.git(['clean', '-qfd']);
    const back = await handoff(s.id, {
      to: { environmentId: local, folder: e.repo },
      source: 'clean',
    });
    expect(back.status).toBe('completed');
    expect(readFileSync(join(e.repo, 'logo.bin')).equals(BINARY)).toBe(true);
    expect(e.svc.info(ACCOUNT, s.id)).toMatchObject({ environmentId: local, hubLocal: true });
    // `clean`: the SSH checkout is back at HEAD.
    expect(clean(box)).toBe(true);
    expect((await e.svc.changes(ACCOUNT, s.id)).length).toBe(4);
    // The handoff's files expire: the bundle goes at once, the patch with the sweep.
    const kept = join(e.dataDir, 'code', 'handoffs', there.id);
    expect(existsSync(join(kept, 'state.bundle'))).toBe(false);
    expect(existsSync(join(kept, 'changes.patch'))).toBe(true);
    expect(await e.handoffs.sweepFiles()).toBe(0);
    expect(await e.handoffs.sweepFiles(0)).toBeGreaterThanOrEqual(2);
    expect(existsSync(kept)).toBe(false);
  });

  it('refuses a target that lacks the commits or whose branch moved elsewhere', async () => {
    e = await makeCodeM7Env();
    const cloud = e.cloudEnv();
    const behind = e.clone('behind');
    const diverged = e.clone('diverged');
    // The session's HEAD is on origin (so no bundle travels) but the first clone never fetched it.
    writeFileSync(join(e.repo, 'app.ts'), 'export const a = 3;\n');
    e.git(['commit', '-qam', 'three']);
    e.git(['push', '-q', 'origin', 'main']);
    writeFileSync(join(diverged, 'other.txt'), 'theirs\n');
    e.gitIn(diverged, ['add', '-A']);
    e.gitIn(diverged, ['commit', '-qm', 'other']);
    e.gitIn(diverged, ['fetch', '-q', 'origin']);
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    writeFileSync(join(e.repo, 'app.ts'), 'export const a = 4;\n');
    const before = e.gitIn(behind, ['rev-parse', 'HEAD']).trim();
    const missing = await handoff(s.id, { to: { environmentId: cloud, folder: behind } });
    expect(missing).toMatchObject({ status: 'refused', reason: 'missing_commits' });
    expect(e.gitIn(behind, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(clean(behind)).toBe(true);
    const moved = await handoff(s.id, { to: { environmentId: cloud, folder: diverged } });
    expect(moved).toMatchObject({ status: 'refused', reason: 'branch_diverged' });
    expect(readFileSync(join(diverged, 'other.txt'), 'utf8')).toBe('theirs\n');
    const missingFolder = await handoff(s.id, {
      to: { environmentId: cloud, folder: join(e.dir, 'nowhere') },
    });
    expect(missingFolder).toMatchObject({ status: 'refused', reason: 'target_missing' });
    // The session never moved and its changes are where they were.
    expect(e.svc.info(ACCOUNT, s.id).hubLocal).toBe(true);
    expect(readFileSync(join(e.repo, 'app.ts'), 'utf8')).toBe('export const a = 4;\n');
    // Request errors are not recorded.
    await expect(
      e.handoffs.start(ACCOUNT, s.id, {
        to: { environmentId: (await e.svc.envs.local(ACCOUNT)).id, folder: e.repo },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // A target that has the commits takes it (a clone that fetched them).
    const fresh = e.clone('fresh');
    const ok = await handoff(s.id, { to: { environmentId: cloud, folder: fresh } });
    expect(ok.status).toBe('completed');
    expect(readFileSync(join(fresh, 'app.ts'), 'utf8')).toBe('export const a = 4;\n');
    expect(e.svc.info(ACCOUNT, s.id)).toMatchObject({ environmentId: cloud, folder: fresh });
  });

  it('never offers Bypass in a cloud environment: the runner is not isolated for modes (FR-063)', async () => {
    e = await makeCodeM7Env({ values: { 'code.allowBypass': true } });
    const cloud = e.cloudEnv();
    // The view says what the mode checks do (docs/10 §12, ADR-095 #30).
    expect(await e.svc.envs.get(ACCOUNT, cloud)).toMatchObject({ kind: 'cloud', isolated: false });
    // On the Hub's container sandbox Bypass is available.
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, permissionMode: 'bypass' });
    expect(s.permissionMode).toBe('bypass');
    // Handed to the cloud, the session falls back to Manual and cannot pick Bypass again.
    const fresh = e.clone('fresh-bypass');
    const ok = await handoff(s.id, { to: { environmentId: cloud, folder: fresh } });
    expect(ok.status).toBe('completed');
    expect((await e.svc.get(ACCOUNT, s.id)).permissionMode).toBe('manual');
    await expect(e.svc.update(ACCOUNT, s.id, { permissionMode: 'bypass' })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'mode_unavailable' },
    });
    // Modes that need no sandbox stay available there.
    const edits = await e.svc.update(ACCOUNT, s.id, { permissionMode: 'accept_edits' });
    expect(edits.permissionMode).toBe('accept_edits');
  });

  it('refuses a session on a detached HEAD, and a target folder in another repository', async () => {
    e = await makeCodeM7Env();
    const cloud = e.cloudEnv();
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    writeFileSync(join(e.repo, 'app.ts'), 'export const a = 6;\n');
    // Not on a branch: commits made at the target would belong to no branch.
    e.git(['checkout', '-q', '--detach']);
    const target = e.clone('detached-target');
    const before = e.gitIn(target, ['rev-parse', 'HEAD']).trim();
    const detached = await handoff(s.id, { to: { environmentId: cloud, folder: target } });
    expect(detached).toMatchObject({ status: 'refused', reason: 'detached_head' });
    expect(e.gitIn(target, ['rev-parse', 'HEAD']).trim()).toBe(before);
    e.git(['checkout', '-q', 'main']);
    // A repository with its own history, even one whose branch has the same name.
    const other = join(e.dir, 'other-repo');
    mkdirSync(other);
    e.gitIn(other, ['init', '-q', '-b', 'main']);
    writeFileSync(join(other, 'README.md'), 'another project\n');
    e.gitIn(other, ['add', '-A']);
    e.gitIn(other, ['commit', '-qm', 'theirs']);
    const otherHead = e.gitIn(other, ['rev-parse', 'HEAD']).trim();
    const elsewhere = await handoff(s.id, { to: { environmentId: cloud, folder: other } });
    expect(elsewhere).toMatchObject({ status: 'refused', reason: 'other_repository' });
    // Nothing reached it, and the session stayed with its changes.
    expect(e.gitIn(other, ['rev-parse', 'HEAD']).trim()).toBe(otherHead);
    expect(e.gitIn(other, ['for-each-ref', '--format=%(refname)']).trim()).toBe('refs/heads/main');
    expect(clean(other)).toBe(true);
    expect(e.svc.info(ACCOUNT, s.id).hubLocal).toBe(true);
    expect(readFileSync(join(e.repo, 'app.ts'), 'utf8')).toBe('export const a = 6;\n');
    // The same repository still takes it.
    const ok = await handoff(s.id, { to: { environmentId: cloud, folder: e.clone('same') } });
    expect(ok.status).toBe('completed');
  });

  it('moves between the main checkout and a worktree in both directions', async () => {
    e = await makeCodeM7Env();
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, title: 'move me' });
    writeFileSync(join(e.repo, 'app.ts'), 'export const a = 5;\n');
    const into = await handoff(s.id, { to: { worktree: 'new' }, source: 'clean' });
    expect(into.status).toBe('completed');
    const inWt = e.svc.info(ACCOUNT, s.id);
    expect(inWt.worktreeId).not.toBeNull();
    expect(inWt.folder).toContain(join('.nova', 'worktrees'));
    expect(inWt.branch).toMatch(/^nova\/move-me/);
    expect(readFileSync(join(inWt.folder, 'app.ts'), 'utf8')).toBe('export const a = 5;\n');
    expect(clean(e.repo)).toBe(true);
    // Back to the main checkout, which takes the worktree's branch.
    writeFileSync(join(e.repo, 'stray.txt'), 'x\n');
    expect((await handoff(s.id, { to: { worktree: 'main' } })).reason).toBe('target_dirty');
    rmSync(join(e.repo, 'stray.txt'));
    const out = await handoff(s.id, { to: { worktree: 'main' }, source: 'clean' });
    expect(out.status).toBe('completed');
    const home = e.svc.info(ACCOUNT, s.id);
    expect(home).toMatchObject({ worktreeId: null, folder: e.repo, branch: inWt.branch });
    expect(e.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(inWt.branch);
    expect(readFileSync(join(e.repo, 'app.ts'), 'utf8')).toBe('export const a = 5;\n');
    // The worktree was cleaned and removed.
    expect(existsSync(inWt.folder)).toBe(false);
    await expect(
      e.handoffs.start(ACCOUNT, s.id, { to: { worktree: 'main' } }),
    ).rejects.toMatchObject({ details: { reason: 'same_location' } });
  });

  it('waits for the running turn, holds the next one and refuses when the turn never ends', async () => {
    e = await makeCodeM7Env();
    const cloud = e.cloudEnv();
    const target = e.clone('cloud-checkout');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const turn = {
      accountId: ACCOUNT,
      threadId: s.threadId,
      mode: 'code' as const,
      trigger: 'user' as const,
      projectId: null,
    };
    const running = await e.svc.extension.forTurn({ ...turn, turnId: 't1' });
    threadState(s.threadId, 'streaming');
    const { view, done } = await e.handoffs.start(ACCOUNT, s.id, {
      to: { environmentId: cloud, folder: target },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(e.handoffs.get(ACCOUNT, view.id).status).toBe('pending');
    threadState(s.threadId, 'idle');
    await running?.onEnd?.({
      turnId: 't1',
      status: 'completed',
      stop: 'end',
      replyText: '',
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      activeMs: 1,
    });
    expect((await done).status).toBe('completed');
    // The next turn runs where the session landed.
    const next = await e.svc.extension.forTurn({ ...turn, turnId: 't2' });
    expect(next?.context?.[0]?.text).toContain('cloud runner');
    // A turn that never ends: refused after the wait.
    threadState(s.threadId, 'streaming');
    const back = (await e.svc.envs.local(ACCOUNT)).id;
    const stuck = await handoff(s.id, { to: { environmentId: back, folder: e.repo } });
    expect(stuck).toMatchObject({ status: 'refused', reason: 'turn_running' });
    expect(e.svc.info(ACCOUNT, s.id).environmentId).toBe(cloud);
  });

  it('refuses a final folder no check approved (the home folder), and keeps the target as it was', async () => {
    e = await makeCodeM7Env();
    const home = e.home;
    // The Hub user's home is a Git repository (dotfiles) with a tracked notes/ folder.
    writeFileSync(join(home, '.gitignore'), 'repo/\n');
    mkdirSync(join(home, 'notes'), { recursive: true });
    writeFileSync(join(home, 'notes', 'readme.md'), '# notes\n');
    e.gitIn(home, ['init', '-q', '-b', 'main']);
    e.gitIn(home, ['config', 'user.name', 'T']);
    e.gitIn(home, ['config', 'user.email', 't@example.invalid']);
    e.gitIn(home, ['add', '-A']);
    e.gitIn(home, ['commit', '-q', '-m', 'dotfiles']);
    const src = join(e.dir, 'src');
    e.gitIn(e.dir, ['clone', '-q', home, src]);
    const s = await e.svc.create(ACCOUNT, { folder: src });
    writeFileSync(join(src, 'x.txt'), 'x\n');
    const local = (await e.svc.envs.local(ACCOUNT)).id;
    // The named folder (~/notes) passes; the folder the session would land in (~) does not.
    const v = await handoff(s.id, { to: { environmentId: local, folder: join(home, 'notes') } });
    expect(v).toMatchObject({ status: 'refused', reason: 'protected_folder' });
    expect(e.svc.info(ACCOUNT, s.id).folder).toBe(src);
    expect(existsSync(join(home, 'x.txt'))).toBe(false);
    expect(e.gitIn(home, ['status', '--porcelain']).trim()).toBe('');
  });

  it('moves a chat to another device', async () => {
    e = await makeCodeM7Env();
    const now = new Date().toISOString();
    e.db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key,
           roles, status, created_at, updated_at)
         VALUES ('dev-1', ?, 'Laptop', 'client', 'linux', 'fp-1', 'pk', '[]', 'active', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    const chat = await e.threads.create(ACCOUNT, { mode: 'chat', title: 'plans' });
    const v = await e.handoffs.startChat(ACCOUNT, chat.id, { to: { deviceId: 'dev-1' } });
    expect(v).toMatchObject({
      status: 'completed',
      to: 'device:dev-1',
      toLabel: 'Laptop',
      sessionId: null,
    });
    expect(e.handoffs.listThread(ACCOUNT, chat.id)).toHaveLength(1);
    expect(e.events.events.find((x) => x.name === 'session.handedOff')?.payload).toMatchObject({
      threadId: chat.id,
      to: 'device:dev-1',
      status: 'completed',
    });
    expect(e.audit.some((a) => a.action === 'thread.handoff')).toBe(true);
    await expect(
      e.handoffs.startChat(ACCOUNT, chat.id, { to: { deviceId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    await expect(
      e.handoffs.startChat(ACCOUNT, s.threadId, { to: { deviceId: 'dev-1' } }),
    ).rejects.toMatchObject({ details: { reason: 'code_thread' } });
  });
});
