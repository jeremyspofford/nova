// Test environment for the M6 Code additions: the M6 tables, a Code service with every M6 part
// (environments, Git hosts, pull requests, dev servers, auto-verify, cross-session operations),
// a recording TurnStarter, and an SSH helper test double whose processes outlive the connection
// and keep their output buffered (FR-078).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NovaError, SETTINGS, type SettingKey } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import {
  AutoVerifier,
  CodeService,
  CodeSessionOps,
  DevServerManager,
  GitHostService,
  GitHubClient,
  PullRequestService,
  gitEnv,
  type AuditRecord,
  type EnvHelperConnection,
  type EnvHelperHello,
  type EnvHelperProcess,
  type EnvHelperRead,
  type EnvHelperSpawn,
  type EnvSshTarget,
  type EnvSshTransport,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
  type StartTurnInput,
  type TurnOutcome,
} from '../src/index.ts';
import { HostSandbox } from './code-env.ts';
import { makeEnv, type Env, type EnvOptions } from './helpers.ts';

// ---- the SSH helper test double ---------------------------------------------------------------

interface FakeProc {
  id: string;
  cmd: string;
  cwd: string;
  tag: string | null;
  out: string;
  exitCode: number | null;
  child: ChildProcess;
  startedAt: string;
  waiters: (() => void)[];
}

/** A remote host running `novad`: it owns its processes, whatever happens to connections. */
export class FakeHelperHost {
  readonly procs = new Map<string, FakeProc>();
  readonly connections: FakeHelperConnection[] = [];
  hello: EnvHelperHello = {
    version: '0.6.0',
    platform: 'linux',
    arch: 'x64',
    verified: true,
    home: null,
  };
  distros = [
    { name: 'Ubuntu', default: true, state: 'running' as const, version: 2 as const },
    { name: 'Debian', default: false, state: 'stopped' as const, version: 2 as const },
  ];
  #next = 0;

  spawn(spec: EnvHelperSpawn): { id: string } {
    const id = `p${++this.#next}`;
    // Its own process group, so a terminate reaches the command's children too.
    const child = spawn('sh', ['-c', spec.cmd], {
      cwd: spec.cwd,
      env: { ...gitEnv({ cwd: spec.cwd }), ...spec.env },
      detached: true,
    });
    const proc: FakeProc = {
      id,
      cmd: spec.cmd,
      cwd: spec.cwd,
      tag: spec.tag ?? null,
      out: '',
      exitCode: null,
      child,
      startedAt: new Date().toISOString(),
      waiters: [],
    };
    const wake = () => {
      for (const w of proc.waiters.splice(0)) w();
    };
    child.stdout?.on('data', (b: Buffer) => {
      proc.out += b.toString('utf8');
      wake();
    });
    child.stderr?.on('data', (b: Buffer) => {
      proc.out += b.toString('utf8');
      wake();
    });
    child.on('close', (code) => {
      proc.exitCode = code ?? -1;
      wake();
    });
    this.procs.set(id, proc);
    return { id };
  }

  async read(id: string, offset: number, waitMs: number): Promise<EnvHelperRead> {
    const p = this.procs.get(id);
    if (!p) throw new NovaError('not_found', 'no such process');
    if (p.out.length <= offset && p.exitCode === null && waitMs > 0)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        p.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    return {
      data: p.out.slice(offset),
      offset: p.out.length,
      dropped: 0,
      running: p.exitCode === null,
      exitCode: p.exitCode,
    };
  }

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = this.procs.get(id)?.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }

  list(): EnvHelperProcess[] {
    return [...this.procs.values()].map((p) => ({
      id: p.id,
      cmd: p.cmd,
      cwd: p.cwd,
      tag: p.tag,
      running: p.exitCode === null,
      exitCode: p.exitCode,
      outputBytes: p.out.length,
      startedAt: p.startedAt,
    }));
  }

  stop(): void {
    for (const p of this.procs.values()) if (p.exitCode === null) this.kill(p.id, 'SIGKILL');
  }
}

/** One connection; `drop()` simulates a lost link (calls then fail, processes keep running). */
export class FakeHelperConnection implements EnvHelperConnection {
  closed = false;
  readonly host: FakeHelperHost;
  readonly distro: string | null;
  constructor(host: FakeHelperHost, distro: string | null = null) {
    this.host = host;
    this.distro = distro;
  }
  drop(): void {
    this.closed = true;
  }
  #live(): void {
    if (this.closed) throw new Error('the connection was lost');
  }
  hello(): Promise<EnvHelperHello> {
    this.#live();
    return Promise.resolve({ ...this.host.hello });
  }
  stat(path: string) {
    this.#live();
    try {
      const st = statSync(path);
      return Promise.resolve({ kind: st.isDirectory() ? ('dir' as const) : ('file' as const) });
    } catch {
      return Promise.resolve(null);
    }
  }
  spawn(spec: EnvHelperSpawn) {
    this.#live();
    return Promise.resolve(this.host.spawn(spec));
  }
  read(id: string, offset: number, waitMs: number) {
    this.#live();
    return this.host.read(id, offset, waitMs);
  }
  write(id: string, input: { signal?: 'interrupt' | 'terminate' }) {
    this.#live();
    if (input.signal) this.host.kill(id);
    return Promise.resolve();
  }
  processes() {
    this.#live();
    return Promise.resolve(this.host.list());
  }
  wslDistros() {
    this.#live();
    if (this.host.hello.platform !== 'win32')
      return Promise.reject(new NovaError('capability_missing', 'not Windows'));
    return Promise.resolve(this.host.distros);
  }
  wsl(distro: string): Promise<EnvHelperConnection> {
    this.#live();
    if (!this.host.distros.some((d) => d.name === distro))
      return Promise.reject(new NovaError('not_found', `no WSL distro ${distro}`));
    const c = new FakeHelperConnection(this.host, distro);
    this.host.connections.push(c);
    return Promise.resolve(c);
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

/** `novad` over SSH, as a test double: checks the key it was given. */
export class FakeSshTransport implements EnvSshTransport {
  readonly host = new FakeHelperHost();
  readonly targets: EnvSshTarget[] = [];
  acceptKey = 'PRIVATE KEY';
  down = false;
  connect(target: EnvSshTarget): Promise<EnvHelperConnection> {
    this.targets.push(target);
    if (this.down) return Promise.reject(new Error('connect ECONNREFUSED'));
    if (target.credential.privateKey !== this.acceptKey && target.credential.password !== 'pw')
      return Promise.reject(new Error('Permission denied (publickey)'));
    const c = new FakeHelperConnection(this.host);
    this.host.connections.push(c);
    return Promise.resolve(c);
  }
}

// ---- a sandbox with running sessions ---------------------------------------------------------

interface HostSession {
  id: string;
  turnId: string | null;
  child: ChildProcess;
  out: string;
  read: number;
  exitCode: number | null;
  closed: Promise<void>;
}

/**
 * Runs commands on the host like a container sandbox with exec sessions: a command still running
 * after its yield time becomes a session to poll, write to or terminate (tests only).
 */
export class SessionSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly reqs: ExecRequest[] = [];
  readonly sessions = new Map<string, HostSession>();
  ok = true;
  #next = 0;

  available() {
    return Promise.resolve({ ok: this.ok, detail: this.ok ? 'host' : 'down' });
  }
  async exec(req: ExecRequest): Promise<ExecResult> {
    this.reqs.push(req);
    if (req.cmd.startsWith('command -v git')) return { status: 'exited', exitCode: 0, output: '' };
    const child = spawn('sh', ['-c', req.cmd], {
      cwd: req.cwd,
      env: { ...gitEnv({ cwd: req.cwd }), ...req.env },
      detached: true,
    });
    const s: HostSession = {
      id: `s${++this.#next}`,
      turnId: req.turnId ?? null,
      child,
      out: '',
      read: 0,
      exitCode: null,
      closed: new Promise<void>((resolve) => child.on('close', () => resolve())),
    };
    child.stdout?.on('data', (b: Buffer) => (s.out += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (s.out += b.toString('utf8')));
    child.on('close', (code) => (s.exitCode = code ?? -1));
    this.sessions.set(s.id, s);
    return this.#wait(s, req.yieldMs);
  }
  poll(sessionId: string, yieldMs: number): Promise<ExecResult> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.reject(new NovaError('not_found', 'no such session'));
    return this.#wait(s, yieldMs);
  }
  write(sessionId: string, input: { signal?: 'interrupt' | 'terminate' }): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s && input.signal) this.#kill(s);
    return Promise.resolve();
  }
  killTurn(turnId: string): Promise<void> {
    for (const s of this.sessions.values()) if (s.turnId === turnId) this.#kill(s);
    return Promise.resolve();
  }
  stop(): void {
    for (const s of this.sessions.values()) this.#kill(s);
  }
  #kill(s: HostSession): void {
    if (s.exitCode !== null || s.child.pid === undefined) return;
    try {
      process.kill(-s.child.pid, 'SIGTERM');
    } catch {
      // Gone.
    }
  }
  async #wait(s: HostSession, yieldMs: number): Promise<ExecResult> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      s.closed,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, yieldMs))),
    ]);
    clearTimeout(timer);
    const output = s.out.slice(s.read);
    s.read = s.out.length;
    if (s.exitCode !== null) {
      this.sessions.delete(s.id);
      return { status: 'exited', exitCode: s.exitCode, output };
    }
    return { status: 'running', sessionId: s.id, output };
  }
}

// ---- the environment -------------------------------------------------------------------------

export interface CodeM6Env extends Env {
  svc: CodeService;
  hosts: GitHostService;
  prs: PullRequestService;
  devServers: DevServerManager;
  verifier: AutoVerifier;
  ops: CodeSessionOps;
  home: string;
  repo: string;
  dataDir: string;
  audit: AuditRecord[];
  values: Partial<Record<SettingKey, unknown>>;
  sandbox: { current: SandboxClient | null };
  secrets: MemorySecretStore;
  ssh: FakeSshTransport;
  turns: StartTurnInput[];
  /** Resolve the `done` of started turns (by index) in tests that wait for them. */
  finishTurn: (index: number, outcome?: Partial<TurnOutcome>) => void;
  git: (args: string[], cwd?: string) => string;
}

export interface CodeM6EnvOptions extends EnvOptions {
  sandbox?: SandboxClient | null;
  values?: Partial<Record<SettingKey, unknown>>;
  containerSandbox?: (image: string) => SandboxClient | null;
  now?: () => Date;
}

export async function makeCodeM6Env(opts: CodeM6EnvOptions = {}): Promise<CodeM6Env> {
  const env = await makeEnv(opts);
  const home = join(env.dir, 'home');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', args, {
      cwd,
      env: {
        ...gitEnv({ cwd }),
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      encoding: 'utf8',
    });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n.env\n.env.*\nsecrets/\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const dataDir = join(env.dir, 'data');
  const audit: AuditRecord[] = [];
  const values: Partial<Record<SettingKey, unknown>> = { ...opts.values };
  const sandbox = { current: opts.sandbox === undefined ? new HostSandbox() : opts.sandbox };
  const secrets = new MemorySecretStore();
  const ssh = new FakeSshTransport();
  const setting = ((key: SettingKey) =>
    Promise.resolve(key in values ? values[key] : SETTINGS[key].default)) as never;
  const auditSink = { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) };
  const svc = new CodeService({
    db: env.db,
    events: env.events,
    audit: auditSink,
    threads: env.threads,
    router: env.router,
    dataDir,
    setting,
    sandbox: () => sandbox.current,
    home,
    secrets,
    sshTransport: ssh,
    ...(opts.containerSandbox ? { containerSandbox: opts.containerSandbox } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const turns: StartTurnInput[] = [];
  const resolvers: ((o: TurnOutcome) => void)[] = [];
  svc.useTurns({
    startTurn: (input) => {
      turns.push(input);
      const done = new Promise<TurnOutcome>((resolve) => resolvers.push(resolve));
      return Promise.resolve({ turnId: `turn-${turns.length}`, messageId: 'm', done });
    },
    cancel: () => Promise.resolve(),
  });
  const hosts = new GitHostService({
    db: env.db,
    secrets,
    audit: auditSink,
    // The mock host speaks GitHub's API on a local port.
    client: (h) => new GitHubClient({ apiUrl: h.apiUrl, token: h.token }),
  });
  const prs = new PullRequestService({
    db: env.db,
    code: svc,
    hosts,
    audit: auditSink,
    setting,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const devServers = new DevServerManager({ code: svc, audit: auditSink, startYieldMs: 300 });
  const verifier = new AutoVerifier({ db: env.db, code: svc, setting });
  svc.useTurnEndHook(verifier.onTurnEnd);
  const ops = new CodeSessionOps({
    code: svc,
    threads: env.threads,
    router: env.router,
    audit: auditSink,
  });
  return {
    ...env,
    svc,
    hosts,
    prs,
    devServers,
    verifier,
    ops,
    home,
    repo,
    dataDir,
    audit,
    values,
    sandbox,
    secrets,
    ssh,
    turns,
    finishTurn: (index, outcome = {}) =>
      resolvers[index]?.({
        turnId: `turn-${index + 1}`,
        status: 'completed',
        stop: 'end',
        replyText: '',
        steps: 1,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        activeMs: 1,
        ...outcome,
      }),
    git,
    close: async () => {
      ssh.host.stop();
      await devServers.close();
      await verifier.close();
      await svc.close();
      await env.close();
    },
  };
}

/** Poll until `fn` is true (tests of background work). */
export async function until(fn: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
