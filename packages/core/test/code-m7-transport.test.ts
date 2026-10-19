// Environment transports (M7, docs/10 §2): the helper transport carries bytes both ways through
// a text channel (base64 framing, chunked large output), drops inherited GIT_* variables, runs
// hook-free Git, and its file API never follows a link out of a folder; sessions on another
// machine get Hub-side change capture, hunk review and commits through it.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalTransport,
  TransportGit,
  helperTransport,
  nodeWorkFs,
  transportWorkFs,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { FakeHelperConnection, FakeHelperHost } from './code-m6-env.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let host: FakeHelperHost | null = null;
let dir: string | null = null;
let e: CodeM7Env | null = null;
afterEach(async () => {
  host?.stop();
  host = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  await e?.close();
  e = null;
});

function remote(): { t: ReturnType<typeof helperTransport>; dir: string } {
  dir = mkdtempSync(join(tmpdir(), 'nova-m7-transport-'));
  host = new FakeHelperHost();
  host.home = join(dir, 'home');
  mkdirSync(host.home);
  const h = host;
  return { t: helperTransport(() => Promise.resolve(new FakeHelperConnection(h)), 'the box'), dir };
}

describe('the helper transport', () => {
  it('carries every byte value in and out, with the exit code and stderr apart', async () => {
    const { t } = remote();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const r = await t.run({
      argv: ['sh', '-c', 'cat; echo oops >&2; exit 3'],
      cwd: '/',
      input: bytes,
    });
    expect(r.code).toBe(3);
    expect(r.stdout.equals(bytes)).toBe(true);
    expect(r.stderr.trim()).toBe('oops');
    // No stdin: the program reads an empty file.
    expect((await t.run({ argv: ['wc', '-c'], cwd: '/' })).stdout.toString().trim()).toBe('0');
  });

  it('fetches output larger than the inline limit in chunks, and refuses more than maxBytes', async () => {
    const { t } = remote();
    const r = await t.run({
      argv: ['sh', '-c', 'head -c 1500000 /dev/zero | tr "\\0" a'],
      cwd: '/',
    });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(1_500_000);
    expect(r.stdout.every((b) => b === 97)).toBe(true);
    await expect(
      t.run({ argv: ['sh', '-c', 'head -c 2000 /dev/zero'], cwd: '/', maxBytes: 100 }),
    ).rejects.toThrow('too large');
  });

  it('removes the variables it is told to and names a state folder in the remote home', async () => {
    const { t } = remote();
    const r = await t.run({
      argv: ['sh', '-c', 'echo "[${GIT_DIR:-}][${KEEP:-}]"'],
      cwd: '/',
      env: { KEEP: 'yes' },
      unset: ['GIT_DIR'],
    });
    expect(r.stdout.toString().trim()).toBe('[][yes]');
    const state = await t.stateDir();
    expect(state).toBe(join(host!.home!, '.nova', 'remote', 'state'));
  });

  it('runs hook-free Git there and says when Git is missing', async () => {
    const { t, dir: d } = remote();
    const repo = join(d, 'repo');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    const git = new TransportGit(t);
    await git.run(['init', '-q', '-b', 'main'], { cwd: repo });
    // A hook that would leave a mark never runs.
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch HOOKED\n', {
      mode: 0o755,
    });
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await git.run(['add', 'a.txt'], { cwd: repo });
    await git.run(['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'one'], {
      cwd: repo,
    });
    expect(existsSync(join(repo, 'HOOKED'))).toBe(false);
    expect(await git.text(['log', '--format=%s'], { cwd: repo })).toBe('one');
    expect(await git.version()).toMatch(/^git version/);
    await expect(git.run(['status'], { cwd: join(d, 'nowhere') })).rejects.toThrow();
    const none = new TransportGit(new LocalTransport({ stateDir: join(d, 's') }));
    // A transport whose machine has no git binary.
    const noGit = new TransportGit({
      label: 'a bare box',
      stateDir: () => Promise.resolve('/'),
      run: () =>
        Promise.resolve({ code: 127, stdout: Buffer.alloc(0), stderr: 'sh: git: not found' }),
    });
    await expect(noGit.run(['status'], { cwd: '/' })).rejects.toMatchObject({
      code: 'capability_missing',
    });
    expect(await none.version()).toMatch(/^git version/);
  });
});

describe('files through a transport', () => {
  it('stats, reads, writes, moves and removes, and never writes through a link out', async () => {
    const { t, dir: d } = remote();
    const fs = transportWorkFs(t);
    const root = join(d, 'root');
    mkdirSync(root);
    const outside = join(d, 'outside');
    mkdirSync(outside);
    await fs.writeFile(join(root, 'a', 'b.bin'), Buffer.from([0, 1, 2, 255]), 0o755);
    expect(await fs.stat(join(root, 'a', 'b.bin'))).toEqual({ kind: 'file', size: 4 });
    expect(await fs.stat(join(root, 'a'))).toMatchObject({ kind: 'dir' });
    expect(await fs.stat(join(root, 'none'))).toBeNull();
    expect([...(await fs.readFile(join(root, 'a', 'b.bin')))]).toEqual([0, 1, 2, 255]);
    await fs.rename(join(root, 'a'), join(root, 'c'));
    expect(await fs.stat(join(root, 'c', 'b.bin'))).toMatchObject({ kind: 'file' });
    symlinkSync(outside, join(root, 'link'));
    for (const files of [fs, nodeWorkFs]) {
      await expect(files.writeWithin(root, 'link/x.txt', 'no')).rejects.toMatchObject({
        code: 'policy_denied',
      });
      await expect(files.writeWithin(root, '../x.txt', 'no')).rejects.toMatchObject({
        code: 'policy_denied',
      });
      // A link deeper in the path is never followed, not even to make a folder behind it.
      await expect(files.writeWithin(root, 'link/sub/x.txt', 'no')).rejects.toMatchObject({
        code: 'policy_denied',
      });
      expect(existsSync(join(outside, 'sub'))).toBe(false);
      await files.writeWithin(root, 'n/m.txt', 'yes');
      expect(readFileSync(join(root, 'n', 'm.txt'), 'utf8')).toBe('yes');
      await files.removeWithin(root, 'n/m.txt');
      expect(existsSync(join(root, 'n', 'm.txt'))).toBe(false);
    }
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    await fs.remove(join(root, 'c'), true);
    expect(await fs.stat(join(root, 'c'))).toBeNull();
  });
});

describe('Hub-side capture for a session on another machine', () => {
  it('captures edits there, reviews them hunk by hunk and commits there', async () => {
    e = await makeCodeM7Env();
    const envId = await e.sshEnv();
    const box = e.clone('box-checkout');
    const s = await e.svc.create(ACCOUNT, { folder: box, environmentId: envId });
    // The shadow lives in Nova's state folder there, never in the repository.
    expect(
      existsSync(join(e.ssh.host.home!, '.nova', 'remote', 'state', 'shadow', `${s.id}.git`)),
    ).toBe(true);
    writeFileSync(join(box, 'app.ts'), 'export const a = 2;\n');
    writeFileSync(join(box, 'new.txt'), 'hello\n');
    const changes = await e.svc.changes(ACCOUNT, s.id);
    expect(changes.map((c) => c.path).sort()).toEqual(['app.ts', 'new.txt']);
    const app = changes.find((c) => c.path === 'app.ts')!;
    expect(app.hunks).toHaveLength(1);
    // Reject the new file (removed there), accept the edit, then commit on a new branch.
    const rejected = changes.find((c) => c.path === 'new.txt')!;
    await e.svc.decideAll(ACCOUNT, s.id, false, [rejected.id]);
    expect(existsSync(join(box, 'new.txt'))).toBe(false);
    await e.svc.decideHunks(ACCOUNT, s.id, app.id, {
      decisions: [{ hunkId: app.hunks[0]!.id, accept: true }],
    });
    await expect(e.svc.commit(ACCOUNT, s.id, { message: 'x' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const c = await e.svc.commit(ACCOUNT, s.id, { message: 'Two', branch: 'two' });
    expect(c).toMatchObject({ branch: 'nova/two', files: 1, hooksRan: false });
    expect(e.gitIn(box, ['log', '-1', '--format=%s']).trim()).toBe('Two');
    expect(e.gitIn(box, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('nova/two');
    expect(e.audit.find((a) => a.action === 'code.commit')?.detail).toMatchObject({
      environmentId: envId,
    });
    // The read-only Git tools work there too.
    expect(await e.svc.gitLog(ACCOUNT, s.threadId, { limit: 1 })).toContain('Two');
    expect(await e.svc.gitStatus(ACCOUNT, s.threadId)).toContain('nova/two');
    // The helper's own bookkeeping runs are not listed as the session's processes.
    expect(await e.svc.envs.processes(ACCOUNT, envId)).toEqual([]);
  });
  it('refuses Hub-side Git through a helper that failed its integrity check', async () => {
    e = await makeCodeM7Env();
    const box = e.clone('box');
    const ssh = await e.sshEnv();
    e.ssh.host.hello = { ...e.ssh.host.hello, verified: false };
    const s = await e.svc.create(ACCOUNT, { environmentId: ssh, folder: box });
    const sandbox = e.svc.sandboxFor({ accountId: ACCOUNT, environmentId: ssh });
    expect((await sandbox!.available()).ok).toBe(false);
    await expect(e.svc.gitStatus(ACCOUNT, s.threadId)).rejects.toMatchObject({
      details: { reason: 'helper_unverified' },
    });
    await expect(e.svc.changes(ACCOUNT, s.id)).rejects.toMatchObject({
      details: { reason: 'helper_unverified' },
    });
  });
});
