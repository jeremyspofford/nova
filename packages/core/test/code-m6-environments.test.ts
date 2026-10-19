// Saved environments (FR-062, FR-078; docs/10 §2): the built-in local one first, container, SSH,
// WSL and device environments saved with their credentials in the keychain, health checks per
// kind, sessions bound to any of them, and the SSH helper double: a dropped connection loses
// nothing because the helper keeps the processes and their output, and reattaching reads it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNovaError } from '@nova/shared';
import { environmentSecretRef, type EnvDeviceProvider, type SandboxClient } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { HostSandbox } from './code-env.ts';
import {
  FakeHelperConnection,
  FakeHelperHost,
  makeCodeM6Env,
  until,
  type CodeM6Env,
} from './code-m6-env.ts';

let e: CodeM6Env;
afterEach(async () => {
  await e.close();
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err))
      return `${err.code}:${String((err.details as { reason?: string } | undefined)?.reason ?? '')}`;
    throw err;
  }
  throw new Error('expected a failure');
}

const sshReq = (label = 'build box') => ({
  kind: 'ssh' as const,
  label,
  connection: { host: 'build.example', port: 22, user: 'dev', auth: 'key' as const },
  credential: { privateKey: 'PRIVATE KEY' },
});

function addDevice(id: string, platform = 'windows'): void {
  const now = new Date().toISOString();
  e.db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key,
         roles, status, created_at, updated_at) VALUES (?, ?, ?, 'client', ?, ?, 'pk', '[]', 'active', ?, ?)`,
    )
    .run(id, ACCOUNT, `dev-${id}`, platform, `fp-${id}`, now, now);
}

describe('saved environments', () => {
  it('lists the built-in local environment first and keeps the M5 view shape', async () => {
    e = await makeCodeM6Env();
    const views = await e.svc.environments(ACCOUNT);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ kind: 'local', label: 'This Hub', status: 'ok' });
    await e.svc.envs.create(ACCOUNT, sshReq());
    const all = await e.svc.envs.list(ACCOUNT);
    expect(all.map((v) => v.kind)).toEqual(['local', 'ssh']);
    expect(all[0]).toMatchObject({ builtIn: true, connection: { kind: 'local' } });
    await expect(e.svc.envs.remove(ACCOUNT, all[0]!.id)).rejects.toThrow(/built-in/);
  });

  it('keeps the SSH key in the keychain and never in the database or the view', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    expect(await e.secrets.get(environmentSecretRef(v.id))).toContain('PRIVATE KEY');
    const row = e.db.raw
      .prepare('SELECT config_json AS c FROM environment WHERE id = ?')
      .get(v.id) as {
      c: string;
    };
    expect(row.c).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(v)).not.toContain('PRIVATE KEY');
    expect(v.connection).toMatchObject({ kind: 'ssh', host: 'build.example', hasCredential: true });
    expect(e.audit.find((a) => a.action === 'environment.created')).toBeTruthy();
    // Key sign-in without a key is refused; a new host needs the credential again.
    await expect(reason(e.svc.envs.create(ACCOUNT, { ...sshReq(), credential: {} }))).resolves.toBe(
      'validation:credential_required',
    );
    await expect(
      reason(
        e.svc.envs.update(ACCOUNT, v.id, {
          connection: { host: 'other.example', port: 22, user: 'dev', auth: 'key' },
        }),
      ),
    ).resolves.toBe('validation:credential_required');
    const relabelled = await e.svc.envs.update(ACCOUNT, v.id, { label: 'renamed' });
    expect(relabelled.label).toBe('renamed');
  });

  it('checks SSH health through the helper and reports why it is down', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    const ok = await e.svc.envs.check(ACCOUNT, v.id);
    expect(ok).toMatchObject({ status: 'ok' });
    expect(ok.detail).toContain('novad 0.6.0');
    expect(e.ssh.targets[0]).toMatchObject({ host: 'build.example', user: 'dev' });
    // An unverified helper never runs.
    e.ssh.host.hello.verified = false;
    expect((await e.svc.envs.check(ACCOUNT, v.id)).status).toBe('down');
    expect(e.events.events.some((x) => x.name === 'environment.health.changed')).toBe(true);
    e.ssh.host.hello.verified = true;
    e.ssh.acceptKey = 'ANOTHER KEY';
    const denied = await e.svc.envs.check(ACCOUNT, v.id);
    expect(denied.status).toBe('down');
    expect(denied.detail).toContain('Permission denied');
    e.ssh.acceptKey = 'PRIVATE KEY';
    e.ssh.down = true;
    expect((await e.svc.envs.check(ACCOUNT, v.id)).detail).toContain('ECONNREFUSED');
  });

  it('is down without an SSH transport, and without the credential in the keychain', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    await e.secrets.delete(environmentSecretRef(v.id));
    const r = await e.svc.envs.check(ACCOUNT, v.id);
    expect(r.status).toBe('down');
    expect(r.detail).toContain('credential is missing');
  });

  it('binds a session to an SSH environment; the symbol index says it is not there', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    const remote = join(e.dir, 'remote-project');
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, 'x.txt'), 'x');
    await expect(
      reason(e.svc.create(ACCOUNT, { folder: join(remote, 'nope'), environmentId: v.id })),
    ).resolves.toBe('validation:missing');
    await expect(
      reason(e.svc.create(ACCOUNT, { folder: join(remote, 'x.txt'), environmentId: v.id })),
    ).resolves.toBe('validation:not_a_folder');
    await expect(
      reason(e.svc.create(ACCOUNT, { folder: remote, environmentId: v.id, worktree: true })),
    ).resolves.toBe('validation:worktree_unavailable');
    for (const folder of ['/etc/nova', '/home/dev/.ssh', '/srv/app/.git'])
      await expect(reason(e.svc.create(ACCOUNT, { folder, environmentId: v.id }))).resolves.toBe(
        'policy_denied:protected_folder',
      );
    const s = await e.svc.create(ACCOUNT, { folder: remote, environmentId: v.id });
    expect(s).toMatchObject({ environmentId: v.id, repo: null });
    expect(s.folder.path).toBe(remote);
    expect(await e.svc.changes(ACCOUNT, s.id)).toEqual([]);
    // M7: commits run there through the transport (this folder is no repository); the symbol
    // index still reads only the Hub's files.
    await expect(e.svc.commit(ACCOUNT, s.id, { message: 'x' })).rejects.toThrow(
      'not a Git repository',
    );
    await expect(reason(e.svc.symbols(ACCOUNT, s.id, 'x'))).resolves.toBe(
      'capability_missing:remote_environment',
    );
    const ext = await e.svc.extension.forTurn({
      accountId: ACCOUNT,
      threadId: s.threadId,
      turnId: 't1',
      mode: 'code',
      trigger: 'user',
      projectId: null,
    });
    expect(ext?.context?.[0]?.text).toContain('SSH environment "build box" (dev@build.example)');
    await ext?.onEnd?.({
      turnId: 't1',
      status: 'completed',
      stop: 'end',
      replyText: '',
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      activeMs: 1,
    });
    // M7: the helper runs its commands, and the sandbox carries the folder there for fs.*.
    const routed = e.svc.sandboxForThread(ACCOUNT, s.threadId) as SandboxClient & {
      files?: { root: string } | null;
    };
    expect(routed.substrate).toBeNull();
    expect(routed.files?.root).toBe(remote);
    // The session is Blocked while its environment is down.
    e.ssh.down = true;
    await e.svc.envs.check(ACCOUNT, v.id);
    expect((await e.svc.get(ACCOUNT, s.id)).derived).toMatchObject({
      status: 'blocked',
      reason: 'Environment down',
    });
    // An environment in use cannot be removed.
    await expect(reason(e.svc.envs.remove(ACCOUNT, v.id))).resolves.toBe('conflict:in_use');
  });

  it('never offers Bypass in an SSH environment: Nova has no sandbox there (FR-063)', async () => {
    e = await makeCodeM6Env({ values: { 'code.allowBypass': true } });
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    const remote = join(e.dir, 'remote-bypass');
    mkdirSync(remote, { recursive: true });
    await expect(
      reason(
        e.svc.create(ACCOUNT, { folder: remote, environmentId: v.id, permissionMode: 'bypass' }),
      ),
    ).resolves.toBe('validation:mode_unavailable');
    const s = await e.svc.create(ACCOUNT, { folder: remote, environmentId: v.id });
    await expect(reason(e.svc.update(ACCOUNT, s.id, { permissionMode: 'bypass' }))).resolves.toBe(
      'validation:mode_unavailable',
    );
    // A local folder on the Hub's container sandbox may use it.
    const local = join(e.dir, 'local-bypass');
    mkdirSync(local, { recursive: true });
    const l = await e.svc.create(ACCOUNT, { folder: local, permissionMode: 'bypass' });
    expect(l.permissionMode).toBe('bypass');
  });

  it('keeps remote commands running across a dropped connection and shows the buffered output (FR-078)', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    const remote = join(e.dir, 'remote');
    mkdirSync(remote);
    const s = await e.svc.create(ACCOUNT, { folder: remote, environmentId: v.id });
    const sandbox = e.svc.sandboxForThread(ACCOUNT, s.threadId)!;
    expect(sandbox.substrate).toBeNull();
    expect((await sandbox.available()).ok).toBe(true);
    const signal = new AbortController().signal;
    const first = await sandbox.exec({
      cmd: 'echo one; sleep 0.4; echo two; sleep 0.4; echo three',
      cwd: remote,
      roots: [],
      network: 'off',
      yieldMs: 150,
      signal,
      turnId: 'turn-a',
    });
    expect(first.status).toBe('running');
    expect(first.output).toContain('one');
    if (first.status !== 'running') return;
    // The link drops; the helper keeps running the command and buffering its output.
    for (const c of e.ssh.host.connections) c.drop();
    await until(() => [...e.ssh.host.procs.values()].every((p) => p.exitCode !== null));
    const rest = await sandbox.poll(first.sessionId, 1_000, signal);
    expect(rest).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(rest.output).toContain('two');
    expect(rest.output).toContain('three');
    expect(e.ssh.targets.length).toBeGreaterThanOrEqual(2);
    // Reattaching from the app: the process list and its whole buffered output.
    const procs = await e.svc.envs.processes(ACCOUNT, v.id);
    expect(procs[0]).toMatchObject({ running: false, exitCode: 0 });
    const out = await e.svc.envs.output(ACCOUNT, v.id, procs[0]!.id, 0);
    expect(out.data).toBe('one\ntwo\nthree\n');
    expect((await e.svc.envs.output(ACCOUNT, v.id, procs[0]!.id, out.offset)).data).toBe('');
    // A cancelled turn's commands are terminated.
    const long = await sandbox.exec({
      cmd: 'sleep 5',
      cwd: remote,
      roots: [],
      network: 'off',
      yieldMs: 10,
      signal,
      turnId: 'turn-b',
    });
    expect(long.status).toBe('running');
    await sandbox.killTurn('turn-b');
    await until(() => [...e.ssh.host.procs.values()].every((p) => p.exitCode !== null));
  });

  it('runs a container environment image and its setup script once per session', async () => {
    const container = new HostSandbox();
    e = await makeCodeM6Env({ containerSandbox: () => container });
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'container',
      label: 'node 22',
      connection: { image: 'node:22-slim', setupScript: 'echo ready > .setup-done' },
    });
    expect(v).toMatchObject({ isolated: true, connection: { image: 'node:22-slim' } });
    expect((await e.svc.envs.check(ACCOUNT, v.id)).status).toBe('ok');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo, environmentId: v.id });
    await until(() => e.svc.setupState(s.id)?.status === 'ok');
    expect(readFileSync(join(e.repo, '.setup-done'), 'utf8')).toBe('ready\n');
    expect(e.svc.sandboxForThread(ACCOUNT, s.threadId)).toBe(container);
    expect((await e.svc.get(ACCOUNT, s.id)).repo).not.toBeNull();
    // A failing image check.
    container.ok = false;
    expect((await e.svc.envs.check(ACCOUNT, v.id)).status).toBe('down');
  });

  it('is down without a container engine', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'container',
      label: 'c',
      connection: { image: 'debian:stable-slim' },
    });
    expect(await e.svc.envs.check(ACCOUNT, v.id)).toMatchObject({
      status: 'down',
      detail: 'no container engine on this Hub',
    });
  });

  it('detects WSL distros only on Windows devices, and checks device environments', async () => {
    e = await makeCodeM6Env();
    addDevice('dev-win');
    addDevice('dev-linux', 'linux');
    await expect(reason(e.svc.envs.wslDistros(ACCOUNT, 'dev-win'))).resolves.toBe(
      'capability_missing:no_device_provider',
    );
    const win = new FakeHelperHost();
    win.hello = { ...win.hello, platform: 'win32' };
    const linux = new FakeHelperHost();
    const online = new Set(['dev-win', 'dev-linux']);
    const provider: EnvDeviceProvider = {
      connect: (_a, deviceId) =>
        Promise.resolve(
          online.has(deviceId)
            ? new FakeHelperConnection(deviceId === 'dev-win' ? win : linux)
            : null,
        ),
    };
    e.svc.envs.useDevices(provider);
    expect((await e.svc.envs.wslDistros(ACCOUNT, 'dev-win')).map((d) => d.name)).toEqual([
      'Ubuntu',
      'Debian',
    ]);
    await expect(reason(e.svc.envs.wslDistros(ACCOUNT, 'dev-linux'))).resolves.toBe(
      'capability_missing:not_windows',
    );
    await expect(reason(e.svc.envs.wslDistros(ACCOUNT, 'unknown'))).resolves.toBe(
      'not_found:unknown_device',
    );
    const wsl = await e.svc.envs.create(ACCOUNT, {
      kind: 'wsl',
      label: 'ubuntu',
      connection: { deviceId: 'dev-win', distro: 'Ubuntu' },
    });
    expect(await e.svc.envs.check(ACCOUNT, wsl.id)).toMatchObject({ status: 'ok' });
    expect((await e.svc.envs.get(ACCOUNT, wsl.id)).detail).toContain('WSL Ubuntu');
    const onLinux = await e.svc.envs.create(ACCOUNT, {
      kind: 'wsl',
      label: 'nope',
      connection: { deviceId: 'dev-linux', distro: 'Ubuntu' },
    });
    expect((await e.svc.envs.check(ACCOUNT, onLinux.id)).detail).toContain('only on a Windows');
    const dev = await e.svc.envs.create(ACCOUNT, {
      kind: 'device',
      label: 'laptop',
      connection: { deviceId: 'dev-linux' },
    });
    expect((await e.svc.envs.check(ACCOUNT, dev.id)).status).toBe('ok');
    online.delete('dev-linux');
    expect(await e.svc.envs.check(ACCOUNT, dev.id)).toMatchObject({
      status: 'down',
      detail: 'the device is offline',
    });
  });

  it('removes an unused environment with its credential', async () => {
    e = await makeCodeM6Env();
    const v = await e.svc.envs.create(ACCOUNT, sshReq());
    await e.svc.envs.remove(ACCOUNT, v.id);
    expect(await e.secrets.get(environmentSecretRef(v.id))).toBeNull();
    await expect(reason(e.svc.envs.get(ACCOUNT, v.id))).resolves.toBe('not_found:');
  });
});
