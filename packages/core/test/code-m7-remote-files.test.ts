// File tools in sessions on another machine (M7 security fix, docs/10 §2): in SSH and device
// sessions, fs.read, fs.list, fs.write, fs.edit and fs.delete reach the session folder there
// through its helper and never touch a Hub-local file planted at the same path; the tools get no
// Hub root at all, the gate keeps the remote folder (a Hub-local path outside it is refused) and
// hides the Hub-only file tools; links never lead out; a machine that cannot be reached fails
// closed. The helper test double runs on a filesystem of its own: paths are rewritten, so the
// same path names a different place than on the Hub.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS } from '@nova/shared';
import { Logger } from '@nova/telemetry';
import { PolicyGate, PolicyStore } from '../src/approvals/index.ts';
import {
  UnavailableSandbox,
  execTools,
  fsTools,
  threadSandboxRouter,
  type SandboxClient,
  type TerminalManager,
  type ToolContext,
  type ToolResult,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { FakeHelperConnection, FakeHelperHost } from './code-m6-env.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let e: CodeM7Env;
let gate: PolicyGate | null = null;
let device: FakeHelperHost | null = null;
afterEach(async () => {
  await gate?.close();
  gate = null;
  device?.stop();
  device = null;
  await e.close();
});

const tools = new Map([...fsTools(), ...execTools()].map((t) => [t.descriptor.name, t]));

/** The Hub view of a path and the remote machine's own place for it. */
function machines(base: string) {
  const hub = join(base, 'hubview');
  const remote = join(base, 'remoteview');
  mkdirSync(join(hub, 'proj'), { recursive: true });
  mkdirSync(join(remote, 'proj'), { recursive: true });
  mkdirSync(join(remote, 'home'), { recursive: true });
  // What the Hub has at that path: it must never be read or written.
  writeFileSync(join(hub, 'proj', 'secret.txt'), 'HUB SECRET\n');
  writeFileSync(join(hub, 'proj', 'hub-only.txt'), 'only on the Hub\n');
  writeFileSync(join(remote, 'proj', 'secret.txt'), 'remote one\nremote two\n');
  return { hub, remote, map: (s: string) => s.split(hub).join(remote) };
}

async function call(
  name: string,
  args: Record<string, unknown>,
  threadId: string,
  sandbox: SandboxClient,
): Promise<ToolResult> {
  const policy = await e.svc.toolPolicy.forThread(ACCOUNT, threadId);
  const ctx: ToolContext = {
    accountId: ACCOUNT,
    threadId,
    turnId: 'turn-f',
    callId: 'call-f',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: policy?.roots ?? [],
    sandbox,
    signal: AbortSignal.timeout(30_000),
    log: new Logger({ module: 'test', sinks: [] }),
  };
  return tools.get(name)!.handler(args, ctx);
}

const text = (r: ToolResult) =>
  r.ok ? r.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : r.error.message;
const code = (r: ToolResult) => (r.ok ? 'ok' : r.error.code);

async function exercise(threadId: string, hub: string, remote: string) {
  const router = threadSandboxRouter(new UnavailableSandbox('no sandbox on this Hub'), (a, t) =>
    e.svc.sandboxForThread(a, t),
  );
  // The tool scope has no root on the Hub for this thread.
  expect((await e.svc.toolPolicy.forThread(ACCOUNT, threadId))?.roots).toEqual([]);
  const read = await call('fs.read', { path: 'secret.txt' }, threadId, router);
  expect(text(read)).toBe('remote one\nremote two\n');
  const listed = await call('fs.list', { path: '.' }, threadId, router);
  expect(text(listed)).toContain('secret.txt');
  expect(text(listed)).not.toContain('hub-only.txt');
  const wrote = await call(
    'fs.write',
    { path: 'sub/new.txt', content: 'made\n' },
    threadId,
    router,
  );
  expect(code(wrote)).toBe('ok');
  expect(readFileSync(join(remote, 'proj', 'sub', 'new.txt'), 'utf8')).toBe('made\n');
  expect(existsSync(join(hub, 'proj', 'sub'))).toBe(false);
  const edited = await call(
    'fs.edit',
    {
      patch: [
        '%%% patch',
        '%%% update secret.txt',
        '@@',
        '-remote two',
        '+remote TWO',
        '%%% end',
      ].join('\n'),
    },
    threadId,
    router,
  );
  expect(code(edited), text(edited)).toBe('ok');
  expect(readFileSync(join(remote, 'proj', 'secret.txt'), 'utf8')).toBe('remote one\nremote TWO\n');
  expect(readFileSync(join(hub, 'proj', 'secret.txt'), 'utf8')).toBe('HUB SECRET\n');
  expect(code(await call('fs.delete', { path: 'sub/new.txt' }, threadId, router))).toBe('ok');
  expect(existsSync(join(remote, 'proj', 'sub', 'new.txt'))).toBe(false);
  // The same path rules as on the Hub: never out of the folder, credentials never, protected
  // paths read-only, links never followed out.
  mkdirSync(join(remote, 'outside'), { recursive: true });
  writeFileSync(join(remote, 'outside', 'x.txt'), 'outside\n');
  symlinkSync(join(remote, 'outside'), join(remote, 'proj', 'link'));
  for (const [name, args] of [
    ['fs.read', { path: '../outside/x.txt' }],
    ['fs.read', { path: join(hub, 'hub-only.txt') }],
    ['fs.read', { path: 'link/x.txt' }],
    ['fs.read', { path: '.ssh/id_rsa' }],
    ['fs.write', { path: 'link/y.txt', content: 'no' }],
    ['fs.write', { path: '.git/config', content: 'no' }],
  ] as const)
    expect(code(await call(name, args, threadId, router)), `${name} ${JSON.stringify(args)}`).toBe(
      'path_denied',
    );
  expect(existsSync(join(remote, 'outside', 'y.txt'))).toBe(false);
  // Commands run there too, in the folder there.
  const ran = await call('exec.run', { cmd: 'cat secret.txt', yieldMs: 20_000 }, threadId, router);
  expect(text(ran)).toContain('remote one');
  expect(text(ran)).not.toContain('HUB SECRET');
  // fs.search is not routed: it refuses (and the gate hides it).
  expect(code(await call('fs.search', { query: 'x' }, threadId, router))).toBe('not_available');
}

describe('file tools in a session on another machine', () => {
  it('reach the SSH session folder there, never the Hub file at the same path', async () => {
    e = await makeCodeM7Env();
    const m = machines(e.dir);
    e.ssh.host.map = m.map;
    e.ssh.host.home = join(m.remote, 'home');
    const s = await e.svc.create(ACCOUNT, {
      folder: join(m.hub, 'proj'),
      environmentId: await e.sshEnv(),
    });
    await exercise(s.threadId, m.hub, m.remote);
    // A terminal runs on the Hub's disk: never at the path of a session on another machine
    // (SSH here, and cloud).
    const opened: unknown[] = [];
    e.svc.useTerminals({
      create: (_accountId: string, input: unknown) => {
        opened.push(input);
        return Promise.resolve({ id: 'term' });
      },
    } as unknown as TerminalManager);
    const size = { cols: 80, rows: 24 };
    await expect(e.svc.openTerminal(ACCOUNT, s.id, size)).rejects.toMatchObject({
      code: 'capability_missing',
    });
    // A local session opens one in its folder; moved to the cloud, it no longer does.
    const local = await e.svc.create(ACCOUNT, { folder: e.repo });
    expect(await e.svc.openTerminal(ACCOUNT, local.id, size)).toEqual({ id: 'term' });
    expect(opened).toHaveLength(1);
    e.db.raw
      .prepare('UPDATE code_session SET environment_id = ? WHERE id = ?')
      .run(e.cloudEnv(), local.id);
    await expect(e.svc.openTerminal(ACCOUNT, local.id, size)).rejects.toMatchObject({
      code: 'capability_missing',
    });
    expect(opened).toHaveLength(1);
  });

  it('reach the device session folder there, through its provider', async () => {
    e = await makeCodeM7Env();
    const m = machines(e.dir);
    const host = new FakeHelperHost();
    device = host;
    host.map = m.map;
    host.home = join(m.remote, 'home');
    e.svc.envs.useDevices({ connect: () => Promise.resolve(new FakeHelperConnection(host)) });
    const now = new Date().toISOString();
    e.db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key,
           roles, status, created_at, updated_at)
         VALUES ('dev-f', ?, 'Laptop', 'client', 'linux', 'fp-f', 'pk', '[]', 'active', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    const env = await e.svc.envs.create(ACCOUNT, {
      kind: 'device',
      label: 'laptop',
      connection: { deviceId: 'dev-f' },
    });
    const s = await e.svc.create(ACCOUNT, { folder: join(m.hub, 'proj'), environmentId: env.id });
    await exercise(s.threadId, m.hub, m.remote);
  });

  it('lets the gate refuse a Hub-local path and hide the Hub-only file tools', async () => {
    e = await makeCodeM7Env();
    const m = machines(e.dir);
    e.ssh.host.map = m.map;
    e.ssh.host.home = join(m.remote, 'home');
    const s = await e.svc.create(ACCOUNT, {
      folder: join(m.hub, 'proj'),
      environmentId: await e.sshEnv(),
    });
    mkdirSync(join(e.dir, 'gate-data', 'workspace'), { recursive: true });
    gate = new PolicyGate({
      store: new PolicyStore({ db: e.db }),
      events: e.events,
      audit: { append: () => Promise.resolve() },
      notifier: { notify: () => Promise.resolve() },
      setting: (key) => Promise.resolve(SETTINGS[key].default as never),
      dataDir: join(e.dir, 'gate-data'),
      home: e.home,
    });
    gate.useThreadPolicy(e.svc.policy);
    gate.useAgentPolicy(e.delegations.delegatedRules({ forThread: () => Promise.resolve(null) }));
    const preview = (name: string, path: string) =>
      gate!.preview({
        accountId: ACCOUNT,
        threadId: s.threadId,
        projectId: null,
        mode: 'code',
        tool: tools.get(name)!.descriptor,
        args: { path },
        resource: { kind: 'path', value: path },
        provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
        profile: { id: 'workspace', hash: 'h' },
      });
    // The gate's root is the folder on that machine; a Hub path outside it is refused.
    expect((await preview('fs.read', '/etc/passwd')).effect).toBe('deny');
    expect((await preview('fs.read', join(e.dataDir, 'secrets.json'))).effect).toBe('deny');
    expect((await preview('fs.read', join(m.hub, 'proj', 'secret.txt'))).effect).not.toBe('deny');
    // Tools that only work on the Hub's disk are hidden there.
    expect((await preview('fs.search', join(m.hub, 'proj'))).effect).toBe('deny');
    // A local session keeps its root on the Hub and reads the Hub's files as before.
    const local = await e.svc.create(ACCOUNT, { folder: e.repo });
    const roots = (await e.svc.toolPolicy.forThread(ACCOUNT, local.threadId))?.roots;
    expect(roots?.[0]?.path).toBe(e.repo);
    const router = threadSandboxRouter(new UnavailableSandbox('x'), (a, t) =>
      e.svc.sandboxForThread(a, t),
    );
    expect(text(await call('fs.read', { path: 'app.ts' }, local.threadId, router))).toBe(
      'export const a = 1;\n',
    );
    expect((await preview('fs.search', e.repo)).effect).toBe('deny');
  });

  it('fails closed when the machine cannot be reached, never falling back to the Hub', async () => {
    e = await makeCodeM7Env();
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    // A thread whose sandbox says it is on another machine that cannot be reached now.
    const unreachable = {
      substrate: null,
      available: () => Promise.resolve({ ok: false, detail: 'unreachable' }),
      exec: () => Promise.reject(new Error('no')),
      poll: () => Promise.reject(new Error('no')),
      write: () => Promise.resolve(),
      killTurn: () => Promise.resolve(),
      filesFor: () => null,
    } as SandboxClient;
    for (const [name, args] of [
      ['fs.read', { path: 'app.ts' }],
      ['fs.write', { path: 'x.txt', content: 'no' }],
      ['fs.list', { path: '.' }],
      ['fs.delete', { path: 'app.ts' }],
    ] as const)
      expect(code(await call(name, args, s.threadId, unreachable))).toBe('remote_unavailable');
    expect(existsSync(join(e.repo, 'x.txt'))).toBe(false);
    expect(existsSync(join(e.repo, 'app.ts'))).toBe(true);
  });
});
