// Computers (FR-080, docs/11 §1-§2): an agent's persistent computer created once and kept across
// restarts, its files confined to its home folder, commands in the sandbox with the home as root
// and HOME, snapshots and restore, stop, the mock cloud computer, connected devices and the
// browser and screen factories, and the agent's computer as the sandbox of its turns.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NovaDatabase } from '@nova/storage';
import { MemoryEventSink } from '../src/events.ts';
import { ComputerService, shellQuote, type DirComputer } from '../src/computers/index.ts';
import type { BrowserController, Computer, ScreenController } from '../src/computers/types.ts';
import type { AuditRecord, ExecRequest } from '../src/tools/types.ts';
import {
  ACCOUNT,
  AGENT,
  AGENT_THREAD,
  OTHER,
  PLAIN_THREAD,
  HostShellSandbox,
  computersDb,
} from './computers-env.ts';

let dir: string;
let db: NovaDatabase;
let sandbox: HostShellSandbox;
let events: MemoryEventSink;
let audit: AuditRecord[];
let kind: 'local_container' | 'cloud';

function service(): ComputerService {
  return new ComputerService({
    db,
    dataDir: dir,
    sandbox: () => sandbox,
    events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    agentComputer: () => Promise.resolve(kind),
    limits: () => Promise.resolve({ wallClockSeconds: 30 }),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-computers-'));
  db = await computersDb();
  sandbox = new HostShellSandbox();
  events = new MemoryEventSink();
  audit = [];
  kind = 'local_container';
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const text = (b: Uint8Array) => Buffer.from(b).toString();
const signal = () => new AbortController().signal;

describe('an agent computer', () => {
  it('is created once, on first use, and survives a restart with its files', async () => {
    const svc = service();
    const [a, b] = await Promise.all([svc.forAgent(ACCOUNT, AGENT), svc.forAgent(ACCOUNT, AGENT)]);
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe('local_container');
    await a.fs.write('notes/today.md', Buffer.from('hello'), { createDirs: true });
    const row = db.raw.prepare('SELECT computer_id FROM agent WHERE id = ?').get(AGENT) as {
      computer_id: string;
    };
    expect(row.computer_id).toBe(a.id);
    expect(audit.filter((x) => x.action === 'computer.create')).toHaveLength(1);
    // A restart: a new service over the same database and folder.
    const again = service();
    expect(await again.recover()).toBe(1);
    const c = await again.forAgent(ACCOUNT, AGENT);
    expect(c.id).toBe(a.id);
    expect(text(await c.fs.read('notes/today.md'))).toBe('hello');
    expect((await c.status()).state).toBe('stopped');
    await expect(svc.forAgent(ACCOUNT, 'no-such-agent')).rejects.toMatchObject({
      code: 'not_found',
    });
    // Another account cannot open it.
    expect(await svc.get(OTHER, a.id)).toBeNull();
    expect(await svc.get(ACCOUNT, a.id)).toBe(a);
  });

  it('keeps file operations inside its home folder', async () => {
    const c = (await service().forAgent(ACCOUNT, AGENT)) as DirComputer;
    await c.fs.write('a.txt', Buffer.from('1'));
    await c.fs.move('a.txt', 'b.txt');
    expect((await c.fs.list('.')).map((d) => [d.name, d.kind, d.size])).toEqual([
      ['b.txt', 'file', 1],
    ]);
    expect((await c.fs.stat('b.txt')).kind).toBe('file');
    expect(text(await c.fs.read(join(c.home, 'b.txt'), { maxBytes: 10 }))).toBe('1');
    await expect(c.fs.read('../../etc/passwd')).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(c.fs.read('/etc/hostname')).rejects.toMatchObject({ code: 'policy_denied' });
    symlinkSync('/etc', join(c.home, 'escape'));
    await expect(c.fs.read('escape/hostname')).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(c.fs.write('escape/x', Buffer.from('x'))).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(c.fs.delete('.')).rejects.toMatchObject({ code: 'policy_denied' });
    await c.fs.delete('b.txt');
    expect(await c.fs.list('.')).toEqual([{ name: 'escape', kind: 'symlink', size: null }]);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['computer.fs.write', 'computer.fs.move', 'computer.fs.delete']),
    );
  });

  it('runs commands in the sandbox with its home as root and HOME, and the agent scope', async () => {
    const c = (await service().forAgent(ACCOUNT, AGENT)) as DirComputer;
    const r = await c.exec(
      { cmd: 'printf', args: ['%s|%s', 'it works', '$HOME'], stdin: 'ignored' },
      signal(),
    );
    expect(r).toEqual({ exitCode: 0, stdout: 'it works|$HOME', stderr: '', timedOut: false });
    const e = await c.exec({ cmd: 'echo "$HOME" >&2; exit 3' }, signal());
    expect(e.exitCode).toBe(3);
    expect(e.stderr.trim()).toBe(realpathSync(c.home));
    const req = sandbox.requests.at(-1)!;
    expect(req.roots.map((x) => x.access)).toEqual(['write']);
    expect(req.env?.HOME).toBe(req.roots[0]?.path);
    expect(req.network).toBe('allowlist');
    expect(req.egress).toEqual({
      accountId: ACCOUNT,
      threadId: null,
      scope: { kind: 'agent', id: AGENT },
    });
    expect(req.timeoutMs).toBe(30_000);
    // Software installed under HOME persists between commands.
    await c.exec(
      {
        cmd: 'mkdir -p .local/bin && printf "#!/bin/sh\\necho tool ran\\n" > .local/bin/tool && chmod +x .local/bin/tool',
      },
      signal(),
    );
    expect((await c.exec({ cmd: '"$HOME/.local/bin/tool"' }, signal())).stdout).toBe('tool ran\n');
    // A call can narrow the network, and a timeout stops it.
    await c.exec({ cmd: 'true', network: 'off' }, signal());
    expect(sandbox.requests.at(-1)?.network).toBe('off');
    const slow = await c.exec({ cmd: 'sleep 5', timeoutMs: 200 }, signal());
    expect(slow.timedOut).toBe(true);
    expect(audit.filter((a) => a.action === 'computer.exec').map((a) => a.result)).toContain(
      'timeout',
    );
    expect(JSON.stringify(audit)).not.toContain('it works');
    // The first use started it.
    expect(events.events.find((e2) => e2.name === 'computer.state.changed')?.payload).toEqual({
      computerId: c.id,
      from: 'stopped',
      to: 'running',
    });
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('fails closed without a sandbox, and reports the degraded mode', async () => {
    const c = await service().forAgent(ACCOUNT, AGENT);
    sandbox.up = false;
    await expect(c.exec({ cmd: 'true' }, signal())).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    const s = await c.status();
    expect(s.state).toBe('degraded');
    expect(s.detail).toContain('engine down');
    // Files still work.
    await c.fs.write('x', Buffer.from('ok'));
  });

  it('snapshots and restores its files, and lists snapshots with label and size', async () => {
    const svc = service();
    const c = (await svc.forAgent(ACCOUNT, AGENT)) as DirComputer;
    await c.fs.write('state.txt', Buffer.from('v1'));
    writeFileSync(join(c.browserProfileDir, 'cookies'), 'session');
    const snap = await svc.snapshot(ACCOUNT, c.id, 'before upgrade');
    expect(snap).toMatchObject({ computerId: c.id, label: 'before upgrade' });
    expect(snap.sizeBytes).toBeGreaterThan(0);
    await c.fs.write('state.txt', Buffer.from('v2'));
    await c.fs.write('new.txt', Buffer.from('later'));
    const view = await svc.restore(ACCOUNT, c.id, snap.id);
    expect(view.snapshotCount).toBe(1);
    expect(text(await c.fs.read('state.txt'))).toBe('v1');
    expect(existsSync(join(c.home, 'new.txt'))).toBe(false);
    expect(readFileSync(join(c.browserProfileDir, 'cookies'), 'utf8')).toBe('session');
    expect(svc.snapshots(ACCOUNT, c.id).map((s) => s.id)).toEqual([snap.id]);
    expect(events.names()).toEqual(
      expect.arrayContaining(['computer.snapshot.created', 'computer.restored']),
    );
    expect(audit.filter((a) => a.kind === 'computer').map((a) => [a.action, a.actor])).toEqual(
      expect.arrayContaining([
        ['computer.snapshot', 'user'],
        ['computer.restore', 'user'],
      ]),
    );
    await expect(svc.restore(ACCOUNT, c.id, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(() => svc.snapshots(OTHER, c.id)).toThrow('no such computer');
    // The Computer interface works the same way.
    const ref = await c.snapshot();
    await c.fs.write('state.txt', Buffer.from('v3'));
    await c.restore(ref);
    expect(text(await c.fs.read('state.txt'))).toBe('v1');
    expect(await svc.deleteSnapshot(ACCOUNT, c.id, snap.id)).toBe(true);
    expect(await svc.deleteSnapshot(ACCOUNT, c.id, snap.id)).toBe(false);
    expect(svc.snapshots(ACCOUNT, c.id).map((s) => s.id)).toEqual([ref.id]);
  });

  it('stops, killing its running commands, and lists computers as views', async () => {
    const svc = service();
    const c = await svc.forAgent(ACCOUNT, AGENT);
    const long = c.exec({ cmd: 'sleep 20' }, signal());
    await new Promise((r) => setTimeout(r, 100));
    const v = await svc.stop(ACCOUNT, c.id);
    expect(v.state).toBe('stopped');
    expect((await long).exitCode).not.toBe(0);
    const [only] = await svc.list(ACCOUNT);
    expect(only).toMatchObject({
      id: c.id,
      kind: 'local_container',
      agentId: AGENT,
      provider: 'container',
      substrate: 'container',
      state: 'stopped',
    });
    expect(await svc.list(OTHER)).toEqual([]);
    expect(audit.some((a) => a.action === 'computer.stop')).toBe(true);
  });
});

describe('the mock cloud computer', () => {
  it('is served by the mock runner: files on the Hub, commands in the local sandbox', async () => {
    kind = 'cloud';
    const svc = service();
    const c = await svc.forAgent(ACCOUNT, AGENT);
    expect(c.kind).toBe('cloud');
    await c.fs.write('report.md', Buffer.from('# hi'));
    expect(existsSync(join(dir, 'cloud-mock', c.id, 'home', 'report.md'))).toBe(true);
    expect((await c.exec({ cmd: 'cat report.md' }, signal())).stdout).toBe('# hi');
    const v = await svc.view(ACCOUNT, c.id);
    expect(v).toMatchObject({ kind: 'cloud', provider: 'mock_cloud', substrate: 'cloud_stub' });
    expect(v.detail).toContain('Mock cloud computer');
    const snap = await svc.snapshot(ACCOUNT, c.id, null);
    await c.fs.write('report.md', Buffer.from('changed'));
    await svc.restore(ACCOUNT, c.id, snap.id);
    expect(text(await c.fs.read('report.md'))).toBe('# hi');
    expect(await svc.purgeAgent(ACCOUNT, AGENT)).toBe(1);
    expect(existsSync(join(dir, 'cloud-mock', c.id))).toBe(false);
    expect(await svc.list(ACCOUNT)).toEqual([]);
  });
});

describe('connected devices, browser and screen', () => {
  it('serves a connected device through the devices area, and only while connected', async () => {
    const svc = service();
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, created_at, updated_at)
         VALUES ('dev-1', ?, 'Laptop', 'client', 'fp-1', 'pk', '[]', ?, ?)`,
      )
      .run(ACCOUNT, new Date().toISOString(), new Date().toISOString());
    const v = await svc.ensureLocalHost(ACCOUNT, { deviceId: 'dev-1', agentId: AGENT });
    expect(v).toMatchObject({ kind: 'local_host', provider: 'novad', substrate: 'host' });
    expect(v.detail).toContain('not connected');
    expect((await svc.ensureLocalHost(ACCOUNT, { deviceId: 'dev-1' })).id).toBe(v.id);
    expect(await svc.get(ACCOUNT, v.id)).toBeNull();
    const device = { id: v.id, kind: 'local_host' } as unknown as Computer;
    svc.useLocalHost({ open: (i) => Promise.resolve(i.deviceId === 'dev-1' ? device : null) });
    expect(await svc.get(ACCOUNT, v.id)).toBe(device);
    await expect(svc.snapshot(ACCOUNT, v.id, null)).rejects.toMatchObject({
      code: 'capability_missing',
    });
    // The agent's own computer is still a separate one.
    expect((await svc.forAgent(ACCOUNT, AGENT)).id).not.toBe(v.id);
  });

  it('gets browser and screen controllers from their areas, or null', async () => {
    const svc = service();
    const c = await svc.forAgent(ACCOUNT, AGENT);
    expect(await c.browser()).toBeNull();
    expect(await c.screen()).toBeNull();
    const browser = { close: () => Promise.resolve() } as unknown as BrowserController;
    const screen = { kill: () => Promise.resolve() } as unknown as ScreenController;
    let profile: string | undefined;
    svc.useBrowser((comp) => {
      profile = comp.browserProfileDir;
      return Promise.resolve(browser);
    });
    svc.useScreen(() => Promise.resolve(screen));
    expect(await c.browser()).toBe(browser);
    expect(await c.screen()).toBe(screen);
    expect(profile).toBe(join(dir, 'computers', c.id, 'browser'));
  });
});

describe("the agent's computer as the sandbox of its turns", () => {
  const req = (threadId: string, over: Partial<ExecRequest> = {}) => ({
    cmd: 'echo $HOME',
    cwd: dir,
    roots: [{ path: dir, access: 'read' as const, label: 'x' }],
    network: 'allowlist' as const,
    yieldMs: 5_000,
    signal: signal(),
    turnId: 'T1',
    owner: { accountId: ACCOUNT, threadId, turnId: 'T1', callId: null },
    ...over,
  });

  it('routes exec in agent threads to the computer and leaves other threads alone', async () => {
    const svc = service();
    const router = svc.sandboxRouter(sandbox);
    expect(router.substrate).toBe('container');
    expect((await router.available()).ok).toBe(true);
    const r = await router.exec(req(AGENT_THREAD));
    const c = (await svc.forAgent(ACCOUNT, AGENT)) as DirComputer;
    const routed = sandbox.requests.at(-1)!;
    expect(routed.roots[0]).toMatchObject({ access: 'write', label: 'computer' });
    expect(routed.env?.HOME).toBe(routed.roots[0]?.path);
    expect(routed.egress).toEqual({
      accountId: ACCOUNT,
      threadId: AGENT_THREAD,
      scope: { kind: 'agent', id: AGENT },
    });
    expect(r).toMatchObject({ status: 'exited', output: `${routed.roots[0]?.path}\n` });
    expect((await c.status()).state).toBe('running');
    await router.exec(req(PLAIN_THREAD));
    const plain = sandbox.requests.at(-1)!;
    expect(plain.roots).toEqual([{ path: dir, access: 'read', label: 'x' }]);
    expect(plain.egress).toBeUndefined();
    // Stopping the computer ends the sessions its turns started.
    const running = await router.exec(req(AGENT_THREAD, { cmd: 'sleep 20', yieldMs: 50 }));
    expect(running.status).toBe('running');
    await svc.stop(ACCOUNT, c.id);
    expect(sandbox.sessions()).toEqual([]);
    await router.killTurn('T1');
  });

  it("gives agent threads the computer's folder as their root", async () => {
    const svc = service();
    const policy = svc.threadPolicy();
    expect(await policy.forThread(ACCOUNT, PLAIN_THREAD)).toBeNull();
    const p = await policy.forThread(ACCOUNT, AGENT_THREAD);
    expect(p?.roots).toHaveLength(1);
    expect(p?.roots?.[0]).toMatchObject({ access: 'write', label: 'computer' });
    svc.useAgentOf(() => Promise.resolve(null));
    expect(await policy.forThread(ACCOUNT, AGENT_THREAD)).toBeNull();
  });

  it('sweeps the files of computers whose rows are gone', async () => {
    const svc = service();
    const c = await svc.forAgent(ACCOUNT, AGENT);
    await svc.snapshot(ACCOUNT, c.id, null);
    db.raw.prepare('DELETE FROM agent WHERE id = ?').run(AGENT);
    expect(await svc.list(ACCOUNT)).toEqual([]);
    expect(svc.sweep()).toBe(2);
    expect(existsSync(join(dir, 'computers', c.id))).toBe(false);
  });
});
