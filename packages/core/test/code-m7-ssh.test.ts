// The SSH transport (FR-062, docs/10 §2, M7), against a stand-in OpenSSH client that runs the
// "remote" side on this machine (no sshd here): host keys pinned on first use and checked after,
// the key from the vault only in a private 0600 file for the life of the connection, the user's
// SSH config and agent never used, the helper installed and checked by SHA-256, commands that
// outlive the call with stdin, signals and buffered output, Hub-side capture over it, password
// sign-in through SSH_ASKPASS, and the off-by-default switch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EnvHelperSandbox,
  OpenSshTransport,
  SSH_HELPER,
  SSH_HELPER_SHA256,
  hostKeyFingerprint,
  normalizeHostKey,
} from '../src/index.ts';
import { sshConnectionSchema } from '@nova/shared';
import { ACCOUNT } from './helpers.ts';
import { FakeHelperConnection, FakeHelperHost, until } from './code-m6-env.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url));
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkQ2Rk1wqkF0b0KxZbYp1xD0p4sYgk0m2Jh9iGQ0a1b';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBk3Zz8YpQm2v6oVqKxNw3cL1fTt0aRZsQe8yHn4Jw7c';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let dir: string;
let e: CodeM7Env | null = null;
afterEach(async () => {
  await e?.close();
  e = null;
  rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  bin: string;
  home: string;
  log: string;
  env: Record<string, string>;
  runDir: string;
  calls: () => Record<string, unknown>[];
}

function fake(): Fake {
  dir = mkdtempSync(join(tmpdir(), 'nova-m7-ssh-'));
  const bin = join(dir, 'ssh');
  writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  const home = join(dir, 'remote-home');
  mkdirSync(home);
  const log = join(dir, 'ssh.log');
  return {
    bin,
    home,
    log,
    runDir: join(dir, 'run'),
    env: {
      FAKE_SSH_HOST_KEY: KEY_A,
      FAKE_SSH_ACCEPT_KEY: 'PRIVATE KEY',
      FAKE_SSH_PASSWORD: 'pw',
      FAKE_SSH_HOME: home,
      FAKE_SSH_LOG: log,
      SSH_AUTH_SOCK: '/tmp/the-users-agent',
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

function transport(f: Fake, enabled = true): OpenSshTransport {
  return new OpenSshTransport({
    runDir: f.runDir,
    sshBin: f.bin,
    env: f.env,
    multiplex: false,
    enabled: () => Promise.resolve(enabled),
  });
}

const target = (over: Record<string, unknown> = {}) => ({
  host: 'build.example',
  port: 2222,
  user: 'dev',
  hostKey: null,
  credential: { privateKey: 'PRIVATE KEY' },
  ...over,
});

describe('the SSH transport', () => {
  it('pins the host key on first use, checks it after, and refuses another one', async () => {
    const f = fake();
    e = await makeCodeM7Env();
    e.svc.envs.useSsh(transport(f));
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'ssh',
      label: 'box',
      connection: { host: 'build.example', port: 2222, user: 'dev', auth: 'key' },
      credential: { privateKey: 'PRIVATE KEY' },
    });
    const first = await e.svc.envs.check(ACCOUNT, v.id);
    expect(first.status).toBe('ok');
    expect(first.connection).toMatchObject({ kind: 'ssh', hostKey: KEY_A });
    expect(e.audit.find((a) => a.action === 'environment.hostkey.pinned')?.detail).toMatchObject({
      environmentId: v.id,
      fingerprint: hostKeyFingerprint(KEY_A),
    });
    expect(
      e.events.events.some(
        (x) =>
          x.name === 'environment.updated' &&
          (x.payload as { change?: string }).change === 'hostkey_pinned',
      ),
    ).toBe(true);
    // The first call accepted a new key; later ones accept only the pinned one.
    const calls = f.calls();
    expect(calls[0]).toMatchObject({
      strict: 'accept-new',
      user: 'dev',
      port: '2222',
      config: '/dev/null',
      identityMode: '600',
      agent: null,
    });
    expect((await e.svc.envs.check(ACCOUNT, v.id)).status).toBe('ok');
    expect(f.calls().at(-1)).toMatchObject({ strict: 'yes' });
    // The host now presents another key: nothing is sent, and the refusal is audited.
    f.env.FAKE_SSH_HOST_KEY = KEY_B;
    const changed = await e.svc.envs.check(ACCOUNT, v.id);
    expect(changed.status).toBe('down');
    expect(changed.detail).toContain('does not match the pinned key');
    expect(e.audit.some((a) => a.action === 'environment.hostkey.mismatch')).toBe(true);
    expect((await e.svc.envs.get(ACCOUNT, v.id)).connection).toMatchObject({ hostKey: KEY_A });
    // An ordinary update cannot change or clear a pinned key.
    for (const hostKey of [KEY_B, null])
      await expect(
        e.svc.envs.update(ACCOUNT, v.id, { connection: { hostKey } }),
      ).rejects.toMatchObject({ details: { reason: 'repin_required' } });
    // The owner re-pins on purpose, audited on its own.
    await e.svc.envs.resetHostKey(ACCOUNT, v.id);
    expect(e.audit.find((a) => a.action === 'environment.hostkey.reset')?.detail).toMatchObject({
      previous: hostKeyFingerprint(KEY_A),
    });
    expect((await e.svc.envs.check(ACCOUNT, v.id)).connection).toMatchObject({ hostKey: KEY_B });
    // Every call names the host only after `--`, so it can never be read as an option.
    expect(f.calls().every((c) => c.dashedHost === true)).toBe(true);
    // Another host: the old host's key is dropped (and that is audited too).
    await e.svc.envs.update(ACCOUNT, v.id, {
      connection: { host: 'other.example' },
      credential: { privateKey: 'PRIVATE KEY' },
    });
    expect((await e.svc.envs.get(ACCOUNT, v.id)).connection).toMatchObject({ hostKey: null });
    expect(
      e.audit.filter((a) => a.action === 'environment.hostkey.reset').map((a) => a.detail),
    ).toContainEqual(expect.objectContaining({ reason: 'host_changed' }));
  });

  it('refuses hosts and users that would read as options, and a racing first key', async () => {
    const f = fake();
    for (const host of ['-Eprobe-ssh.log', '-G', '-Jjump.example'])
      expect(() =>
        sshConnectionSchema.parse({ host, port: 22, user: 'dev', auth: 'password' }),
      ).toThrow();
    const t = transport(f);
    for (const over of [{ host: '-G' }, { user: '-oProxyCommand=x' }])
      await expect(t.connect(target(over), AbortSignal.timeout(30_000))).rejects.toMatchObject({
        details: { reason: 'invalid_target' },
      });
    expect(f.calls()).toEqual([]);
    // Two first connections: the one that loses the race must have seen the winner's key.
    e = await makeCodeM7Env();
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'ssh',
      label: 'box',
      connection: { host: 'build.example', port: 22, user: 'dev', auth: 'key' },
      credential: { privateKey: 'PRIVATE KEY' },
    });
    const host = new FakeHelperHost();
    const db = e.db;
    e.svc.envs.useSsh({
      connect: () => {
        // The other connection pins KEY_B while this one saw KEY_A.
        const row = db.raw
          .prepare('SELECT config_json AS c FROM environment WHERE id = ?')
          .get(v.id) as { c: string };
        db.raw
          .prepare('UPDATE environment SET config_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...(JSON.parse(row.c) as object), hostKey: KEY_B }), v.id);
        return Promise.resolve(Object.assign(new FakeHelperConnection(host), { hostKey: KEY_A }));
      },
    });
    const raced = await e.svc.envs.check(ACCOUNT, v.id);
    expect(raced.status).toBe('down');
    expect(raced.detail).toContain('does not match the pinned key');
    expect(e.audit.some((a) => a.action === 'environment.hostkey.mismatch')).toBe(true);
  });

  it('cleans up key copies a crash left, and quotes folders with spaces for the client', async () => {
    const f = fake();
    const stale = join(f.runDir, 'c-left-behind');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'id'), 'PRIVATE KEY');
    transport(f);
    expect(existsSync(stale)).toBe(false);
    const spaced = new OpenSshTransport({
      runDir: join(dir, 'run dir'),
      sshBin: f.bin,
      env: f.env,
      multiplex: false,
    });
    const conn = await spaced.connect(target(), AbortSignal.timeout(30_000));
    expect((await conn.hello()).verified).toBe(true);
    // The helper runs by the absolute path its SHA-256 was checked at.
    expect(await conn.stat(f.home)).toEqual({ kind: 'dir' });
    expect(String(f.calls().at(-1)?.remote)).toBe(
      `sh ${join(f.home, '.nova', 'remote', 'helper.sh')} stat ${f.home}`,
    );
    await conn.close();
    const quoted = new OpenSshTransport({
      runDir: join(dir, 'run"dir'),
      sshBin: f.bin,
      multiplex: false,
    });
    await expect(quoted.connect(target(), AbortSignal.timeout(30_000))).rejects.toThrow('quotes');
  });

  it('keeps the key only for the life of the connection and installs a checked helper', async () => {
    const f = fake();
    const t = transport(f);
    const conn = await t.connect(target(), AbortSignal.timeout(30_000));
    expect(conn.hostKey).toBe(normalizeHostKey(KEY_A));
    const [cdir] = readdirSync(f.runDir);
    const keyFile = join(f.runDir, cdir!, 'id');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(await conn.hello()).toMatchObject({ verified: true, platform: 'linux', home: f.home });
    const helper = join(f.home, '.nova', 'remote', 'helper.sh');
    expect(readFileSync(helper, 'utf8')).toBe(SSH_HELPER);
    expect(createHash('sha256').update(readFileSync(helper)).digest('hex')).toBe(SSH_HELPER_SHA256);
    await conn.close();
    expect(existsSync(join(f.runDir, cdir!))).toBe(false);
    // A helper changed on the host is replaced before it runs.
    writeFileSync(helper, '#!/bin/sh\necho tampered\n');
    const again = await t.connect(target({ hostKey: KEY_A }), AbortSignal.timeout(30_000));
    expect((await again.hello()).verified).toBe(true);
    expect(readFileSync(helper, 'utf8')).toBe(SSH_HELPER);
    await again.close();
  });

  it('runs commands that outlive the call, with stdin, signals and buffered output', async () => {
    const f = fake();
    const t = transport(f);
    const conn = await t.connect(target({ hostKey: KEY_A }), AbortSignal.timeout(30_000));
    const box = new EnvHelperSandbox(() => Promise.resolve(conn));
    const done = await box.exec({
      cmd: 'echo out; echo err >&2; exit 3',
      cwd: f.home,
      roots: [],
      network: 'off',
      env: { GREETING: "it's" },
      yieldMs: 10_000,
      signal: AbortSignal.timeout(20_000),
      turnId: 't1',
    });
    expect(done).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(done.output).toContain('out');
    expect(done.output).toContain('err');
    const env = await box.exec({
      cmd: 'printf "%s\\n" "$GREETING"',
      cwd: f.home,
      roots: [],
      network: 'off',
      env: { GREETING: 'it\'s "quoted" $HOME' },
      yieldMs: 10_000,
      signal: AbortSignal.timeout(20_000),
    });
    expect(env.output.trim()).toBe('it\'s "quoted" $HOME');
    // A process that waits for input: it keeps running across calls and reads what we send.
    const r = await box.exec({
      cmd: 'read line; echo "got $line"',
      cwd: f.home,
      roots: [],
      network: 'off',
      yieldMs: 300,
      signal: AbortSignal.timeout(20_000),
      turnId: 't2',
    });
    expect(r.status).toBe('running');
    const id = (r as { sessionId: string }).sessionId;
    await box.write(id, { text: 'hello\n', closeStdin: true });
    const end = await box.poll(id, 10_000, AbortSignal.timeout(20_000));
    expect(end).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(end.output).toContain('got hello');
    // A long one is terminated with its group.
    const long = await box.exec({
      cmd: 'sleep 30',
      cwd: f.home,
      roots: [],
      network: 'off',
      yieldMs: 200,
      signal: AbortSignal.timeout(20_000),
      turnId: 't3',
    });
    expect(long.status).toBe('running');
    await box.killTurn('t3');
    const lid = (long as { sessionId: string }).sessionId;
    await until(async () => {
      const p = (await conn.processes()).find((x) => x.id === lid);
      return p?.running === false;
    }, 10_000);
    // Every process is listed, with its command line, folder and output size.
    const listed = await conn.processes();
    expect(listed.length).toBeGreaterThanOrEqual(4);
    expect(listed.find((p) => p.id === id)).toMatchObject({
      cwd: f.home,
      running: false,
      exitCode: 0,
    });
    expect(await conn.stat(f.home)).toEqual({ kind: 'dir' });
    expect(await conn.stat(join(f.home, 'none'))).toBeNull();
    await conn.close();
  });

  it('captures changes Hub-side over SSH, signs in with a password, and is off unless enabled', async () => {
    const f = fake();
    e = await makeCodeM7Env();
    e.svc.envs.useSsh(transport(f));
    const project = join(f.home, 'project');
    execFileSync('git', ['clone', '-q', e.origin, project]);
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'ssh',
      label: 'box',
      connection: { host: 'build.example', port: 22, user: 'dev', auth: 'password' },
      credential: { password: 'pw' },
    });
    const s = await e.svc.create(ACCOUNT, { folder: project, environmentId: v.id });
    writeFileSync(join(project, 'app.ts'), 'export const a = 9;\n');
    expect((await e.svc.changes(ACCOUNT, s.id)).map((c) => c.path)).toEqual(['app.ts']);
    // A wrong password, an unreachable host, and the switch off.
    const t = transport(f);
    await expect(
      t.connect(target({ credential: { password: 'nope' } }), AbortSignal.timeout(30_000)),
    ).rejects.toMatchObject({ details: { reason: 'ssh_auth_failed' } });
    f.env.FAKE_SSH_DOWN = '1';
    await expect(t.connect(target(), AbortSignal.timeout(30_000))).rejects.toMatchObject({
      details: { reason: 'ssh_unreachable' },
    });
    await expect(
      transport(f, false).connect(target(), AbortSignal.timeout(30_000)),
    ).rejects.toMatchObject({ details: { reason: 'ssh_disabled' } });
    // Each Git call is a few SSH round trips through the stand-in client.
  }, 60_000);
});
