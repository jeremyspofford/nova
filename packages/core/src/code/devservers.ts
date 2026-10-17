// Dev servers of Code sessions (FR-097, FR-067; docs/10 §7). Common frameworks are detected in
// the session folder: package.json `dev`/`start`/`serve`/`preview` scripts (Vite, Next.js, Create
// React App, Astro, Nuxt, SvelteKit, webpack), Django (`manage.py`), Rails, Go modules, and the
// custom configurations of `.nova/launch.json`. A server starts as an exec session in the session's
// environment sandbox (listed in the terminal pane, killed from there too), and stops alone or with
// every server of the session. The sandbox has its own network namespace, so the server's port is
// published through the dev-server bridge (tools/sandbox-publish.ts): its URL is the bridge's port
// on the Hub's 127.0.0.1, closed with the server. The browser area reaches it only through the
// egress proxy's dev-server grant for exactly that host and port (docs/12 §4.2, §8), asked for
// through a late-bound hook, and the browser pane opens it (late-bound too) once it answers.
import { request as httpRequest } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { NovaError, uuidv7, type DevServerCandidateView, type DevServerView } from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import { Logger } from '@nova/telemetry';
import type { ExecRequestExtras } from '../tools/sandbox-process.ts';
import type { AuditSink, ExecRequest, ExecResult, SandboxClient } from '../tools/types.ts';
import { isCredentialRel, isProtectedRel } from '../tools/roots.ts';
import type { CodeService, CodeSessionInfo } from './service.ts';

/** How long a start waits for a server that exits at once (a broken command). */
const START_YIELD_MS = 3_000;
/** How long a start waits for the server to answer before the browser opens it in the background. */
const READY_WAIT_MS = 2_000;
/** How long the browser pane waits for a server to answer at all (a first compile). */
const READY_TIMEOUT_MS = 120_000;
/** Dev servers of one session at most. */
export const MAX_DEV_SERVERS = 4;

/**
 * The egress proxy's dev-server grant (computers area): lets the browser pane reach a local dev
 * host. Returns the URL to open (the proxy may map it) and how to revoke the grant; null when no
 * grant was given.
 */
export type DevServerGrant = (input: {
  accountId: string;
  sessionId: string;
  threadId: string;
  serverId: string;
  host: string;
  port: number;
}) => Promise<{ url: string | null; revoke(): Promise<void> } | null>;

/** The browser area's controller, told when a dev server's URL is ready to open. */
export type DevServerOpener = (input: {
  accountId: string;
  sessionId: string;
  threadId: string;
  url: string;
}) => Promise<void>;

interface Script {
  framework: string;
  port: number;
  /** Extra arguments that set the port (after `--`). */
  portArgs: (port: number) => string[];
}

interface ServerRec {
  view: DevServerView;
  accountId: string;
  threadId: string;
  sandbox: SandboxClient;
  revoke: (() => Promise<void>) | null;
  /** Waiting for the server to answer before the browser pane opens it. */
  opening: AbortController | null;
}

export interface DevServerManagerOptions {
  code: CodeService;
  audit: AuditSink;
  /** How long a start waits to see whether the server exits at once (default 3 s). */
  startYieldMs?: number;
  /**
   * How long a start waits for the server to answer before the browser pane opens it; a slower
   * server is opened in the background once it answers (default 2 s).
   */
  readyWaitMs?: number;
  /** How long the browser pane waits for a server to answer at all (default 2 min). */
  readyTimeoutMs?: number;
  now?: () => Date;
  log?: Logger;
}

export class DevServerManager {
  readonly #o: DevServerManagerOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #servers = new Map<string, ServerRec>();
  #grant: DevServerGrant | null = null;
  #opener: DevServerOpener | null = null;

  constructor(opts: DevServerManagerOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.devservers', sinks: [] });
  }

  /** The egress proxy's dev-server grant (computers area, late-bound). */
  useGrant(grant: DevServerGrant): void {
    this.#grant = grant;
  }

  /** The browser pane's controller (browser area, late-bound). */
  useOpener(opener: DevServerOpener): void {
    this.#opener = opener;
  }

  /** What can be started in the session folder. */
  async detect(accountId: string, sessionId: string): Promise<DevServerCandidateView[]> {
    const s = this.#o.code.info(accountId, sessionId);
    if (!s.hubLocal) return [];
    return detectDevServers(s.folder);
  }

  /** The session's dev servers, with exits noticed. */
  async list(accountId: string, sessionId: string): Promise<DevServerView[]> {
    const s = this.#o.code.info(accountId, sessionId);
    const out: DevServerView[] = [];
    for (const rec of this.#servers.values()) {
      if (rec.view.sessionId !== s.id) continue;
      await this.#notice(rec);
      out.push({ ...rec.view });
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async start(
    accountId: string,
    sessionId: string,
    req: { candidateId?: string; port?: number },
    actor: 'user' | 'agent',
  ): Promise<DevServerView> {
    const s = this.#o.code.info(accountId, sessionId);
    if (!s.active) throw new NovaError('conflict', 'the session is archived');
    if (!s.hubLocal)
      throw new NovaError('capability_missing', 'dev servers run only for folders on the Hub yet', {
        details: { reason: 'remote_environment' },
      });
    const candidates = await detectDevServers(s.folder);
    const c = req.candidateId ? candidates.find((x) => x.id === req.candidateId) : candidates[0];
    if (!c)
      throw new NovaError(
        req.candidateId ? 'not_found' : 'validation',
        req.candidateId
          ? `no dev server ${req.candidateId} in this folder`
          : 'no dev server found (package.json dev script, manage.py, Rails, Go or .nova/launch.json)',
        { details: { reason: 'no_dev_server' } },
      );
    const running = [...this.#servers.values()].filter(
      (r) =>
        r.view.sessionId === s.id && (r.view.status === 'running' || r.view.status === 'starting'),
    );
    const same = running.find((r) => r.view.candidateId === c.id);
    if (same) return { ...same.view };
    if (running.length >= MAX_DEV_SERVERS)
      throw new NovaError('conflict', `at most ${MAX_DEV_SERVERS} dev servers run per session`, {
        details: { reason: 'too_many_dev_servers' },
      });
    const sandbox = this.#o.code.sandboxFor(s) ?? this.#o.code.hubSandbox();
    if (!sandbox || !(await sandbox.available()).ok)
      throw new NovaError('sandbox_unavailable', 'no sandbox is available to run the dev server');
    const port = req.port ?? this.#freePort(c.port ?? 3000);
    const id = uuidv7();
    const cwd = c.cwd ? join(s.folder, c.cwd) : s.folder;
    const command = withPort(c, port);
    const view: DevServerView = {
      id,
      sessionId: s.id,
      candidateId: c.id,
      label: c.label,
      command,
      status: 'starting',
      url: null,
      port,
      execSessionId: null,
      exitCode: null,
      startedAt: this.#iso(),
      stoppedAt: null,
    };
    const req2: ExecRequest &
      ExecRequestExtras & {
        owner: { accountId: string; threadId: string; turnId: string; callId: null };
      } = {
      cmd: command,
      cwd,
      roots: [{ path: s.folder, access: 'write', label: 'session folder' }],
      // The server binds a port on the sandbox's own loopback; the bridge publishes it on the
      // Hub's, and reaching that is the egress proxy's dev-server grant. No network otherwise.
      network: 'off',
      env: { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' },
      yieldMs: this.#o.startYieldMs ?? START_YIELD_MS,
      signal: AbortSignal.timeout((this.#o.startYieldMs ?? START_YIELD_MS) + 60_000),
      turnId: `devserver:${id}`,
      owner: { accountId, threadId: s.threadId, turnId: `devserver:${id}`, callId: null },
      publish: { port },
    };
    const r = await sandbox.exec(req2);
    const rec: ServerRec = {
      view,
      accountId,
      threadId: s.threadId,
      sandbox,
      revoke: null,
      opening: null,
    };
    if (r.status === 'exited') {
      view.status = 'failed';
      view.exitCode = r.exitCode;
      view.stoppedAt = this.#iso();
      this.#servers.set(id, rec);
      await this.#audit(s, actor, 'code.devserver.start', view, 'error', tail(r.output));
      throw new NovaError('conflict', `the dev server exited at once (exit ${r.exitCode})`, {
        details: { reason: 'dev_server_exited', output: tail(r.output), server: { ...view } },
      });
    }
    view.execSessionId = r.sessionId;
    view.status = 'running';
    // The bridge's port on the Hub. A sandbox that shares the Hub's network (none of the Hub's
    // substrates; test doubles) serves the server's own port.
    const hostPort = r.published?.hostPort ?? port;
    let url = `http://127.0.0.1:${hostPort}/`;
    if (this.#grant) {
      try {
        const g = await this.#grant({
          accountId,
          sessionId: s.id,
          threadId: s.threadId,
          serverId: id,
          host: '127.0.0.1',
          port: hostPort,
        });
        if (g) {
          rec.revoke = () => g.revoke();
          if (g.url) url = g.url;
        }
      } catch (err) {
        this.#log.warn('the dev-server grant failed', { err, serverId: id });
      }
    }
    view.url = url;
    this.#servers.set(id, rec);
    await this.#audit(s, actor, 'code.devserver.start', view, 'ok', null);
    await this.#o.code.announce(s, 'code.devserver.started', {
      sessionId: s.id,
      serverId: id,
      url,
      port,
      label: c.label,
    });
    if (this.#opener) await this.#open(rec, this.#opener, url, hostPort);
    return { ...view };
  }

  /**
   * Open the server in the browser pane once it answers: within the start when it is quick,
   * otherwise in the background, never after it stopped.
   */
  async #open(rec: ServerRec, opener: DevServerOpener, url: string, port: number): Promise<void> {
    const ctl = new AbortController();
    rec.opening = ctl;
    const open = async () => {
      if (ctl.signal.aborted || rec.view.status !== 'running') return;
      await opener({
        accountId: rec.accountId,
        sessionId: rec.view.sessionId,
        threadId: rec.threadId,
        url,
      }).catch((err: unknown) => this.#log.warn('opening the dev server failed', { err }));
    };
    const quick = this.#o.readyWaitMs ?? READY_WAIT_MS;
    if (await answers(port, quick, ctl.signal)) {
      if (rec.opening === ctl) rec.opening = null;
      await open();
      return;
    }
    const rest = Math.max(0, (this.#o.readyTimeoutMs ?? READY_TIMEOUT_MS) - quick);
    void answers(port, rest, ctl.signal)
      .then((ready) => (ready ? open() : undefined))
      .finally(() => {
        if (rec.opening === ctl) rec.opening = null;
      });
  }

  async stop(
    accountId: string,
    sessionId: string,
    serverId: string,
    actor: 'user' | 'agent',
  ): Promise<DevServerView> {
    const s = this.#o.code.info(accountId, sessionId);
    const rec = this.#servers.get(serverId);
    if (rec?.view.sessionId !== s.id) throw new NovaError('not_found', 'dev server not found');
    await this.#stop(rec);
    await this.#audit(s, actor, 'code.devserver.stop', rec.view, 'ok', null);
    return { ...rec.view };
  }

  /** Stop every dev server of the session (the header's Stop all). */
  async stopAll(accountId: string, sessionId: string, actor: 'user' | 'agent') {
    const s = this.#o.code.info(accountId, sessionId);
    const out: DevServerView[] = [];
    for (const rec of this.#servers.values()) {
      if (rec.view.sessionId !== s.id) continue;
      if (rec.view.status === 'running' || rec.view.status === 'starting') {
        await this.#stop(rec);
        await this.#audit(s, actor, 'code.devserver.stop', rec.view, 'ok', null);
      }
      out.push({ ...rec.view });
    }
    return out;
  }

  /** Stop the servers of sessions that were archived (the Hub's sweep) and at shutdown. */
  async stopInactive(active: (sessionId: string) => boolean): Promise<number> {
    let n = 0;
    for (const rec of this.#servers.values()) {
      if (rec.view.status !== 'running' && rec.view.status !== 'starting') continue;
      if (active(rec.view.sessionId)) continue;
      await this.#stop(rec);
      n++;
    }
    return n;
  }

  async close(): Promise<void> {
    await this.stopInactive(() => false);
  }

  async #stop(rec: ServerRec): Promise<void> {
    rec.opening?.abort();
    rec.opening = null;
    if (rec.view.status === 'running' || rec.view.status === 'starting') {
      if (rec.view.execSessionId)
        await rec.sandbox
          .write(rec.view.execSessionId, { signal: 'terminate' })
          .catch(() => undefined);
      await rec.sandbox.killTurn(`devserver:${rec.view.id}`).catch(() => undefined);
      rec.view.status = 'stopped';
      rec.view.stoppedAt = this.#iso();
      await this.#announceStop(rec);
    }
    if (rec.revoke) {
      const revoke = rec.revoke;
      rec.revoke = null;
      await revoke().catch((err: unknown) =>
        this.#log.warn('revoking the dev-server grant failed', { err }),
      );
    }
  }

  /** Notice a server that exited by itself. */
  async #notice(rec: ServerRec): Promise<void> {
    if (rec.view.status !== 'running' || !rec.view.execSessionId) return;
    let r: ExecResult;
    try {
      r = await rec.sandbox.poll(rec.view.execSessionId, 0, AbortSignal.timeout(5_000));
    } catch {
      // The session is gone (killed from the terminal pane or the Hub restarted).
      r = { status: 'exited', exitCode: -1, output: '' };
    }
    if (r.status === 'exited') {
      rec.opening?.abort();
      rec.opening = null;
      rec.view.status = r.exitCode === 0 ? 'stopped' : 'failed';
      rec.view.exitCode = r.exitCode;
      rec.view.stoppedAt = this.#iso();
      await this.#announceStop(rec);
      if (rec.revoke) await rec.revoke().catch(() => undefined);
      rec.revoke = null;
    }
  }

  async #announceStop(rec: ServerRec): Promise<void> {
    await this.#o.code.announce(
      { id: rec.view.sessionId, accountId: rec.accountId, threadId: rec.threadId },
      'code.devserver.stopped',
      { sessionId: rec.view.sessionId, serverId: rec.view.id, exitCode: rec.view.exitCode },
    );
  }

  #freePort(want: number): number {
    const used = new Set(
      [...this.#servers.values()]
        .filter((r) => r.view.status === 'running' || r.view.status === 'starting')
        .map((r) => r.view.port),
    );
    let p = want;
    while (used.has(p) && p < 65_535) p++;
    return p;
  }

  async #audit(
    s: CodeSessionInfo,
    actor: string,
    action: string,
    v: DevServerView,
    result: string,
    output: string | null,
  ): Promise<void> {
    await this.#o.audit.append({
      accountId: s.accountId,
      actor,
      kind: 'code',
      action,
      resource: s.folder,
      result,
      threadId: s.threadId,
      detail: {
        sessionId: s.id,
        serverId: v.id,
        command: defaultRedactor.redactString(v.command),
        port: v.port,
        ...(output ? { output } : {}),
      },
    });
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

/** One HTTP answer from 127.0.0.1:port (any status), or false. */
function answersOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'HEAD', path: '/', agent: false, timeout: timeoutMs },
      (res) => {
        res.resume();
        req.destroy();
        resolve(true);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Whether a server answers HTTP on 127.0.0.1:port within `ms` (tried every 250 ms). */
async function answers(port: number, ms: number, signal: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (signal.aborted) return false;
    const left = end - Date.now();
    if (left <= 0) return false;
    if (await answersOnce(port, Math.min(left, 10_000))) return !signal.aborted;
    if (end - Date.now() <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, end - Date.now()))));
  }
}

// ---- detection ---------------------------------------------------------------------------------

const SCRIPT_NAMES = ['dev', 'start', 'serve', 'preview'] as const;

function frameworkOf(script: string, deps: Record<string, unknown>): Script {
  const has = (n: string) => n in deps || new RegExp(`\\b${n}\\b`).test(script);
  const after = (flag: string) => (p: number) => [flag, String(p)];
  if (has('next')) return { framework: 'Next.js', port: 3000, portArgs: after('-p') };
  if (has('nuxt')) return { framework: 'Nuxt', port: 3000, portArgs: after('--port') };
  if (has('astro')) return { framework: 'Astro', port: 4321, portArgs: after('--port') };
  if (/@sveltejs\/kit/.test(Object.keys(deps).join(' ')))
    return { framework: 'SvelteKit', port: 5173, portArgs: after('--port') };
  if (has('vite')) return { framework: 'Vite', port: 5173, portArgs: after('--port') };
  if (has('react-scripts'))
    return { framework: 'Create React App', port: 3000, portArgs: () => [] };
  if (has('webpack-dev-server') || /webpack\s+serve/.test(script))
    return { framework: 'webpack', port: 8080, portArgs: after('--port') };
  return { framework: 'Node.js', port: 3000, portArgs: () => [] };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Detect dev servers in a folder (FR-097). Order: launch.json, package.json, Django, Rails, Go. */
export async function detectDevServers(folder: string): Promise<DevServerCandidateView[]> {
  const out: DevServerCandidateView[] = [];
  out.push(...(await fromLaunchJson(folder)));
  try {
    const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = (await exists(join(folder, 'pnpm-lock.yaml')))
      ? 'pnpm'
      : (await exists(join(folder, 'yarn.lock')))
        ? 'yarn'
        : 'npm';
    for (const name of SCRIPT_NAMES) {
      const script = pkg.scripts?.[name];
      if (typeof script !== 'string') continue;
      const fw = frameworkOf(script, deps);
      out.push({
        id: `${pm}:${name}`,
        label: `${fw.framework} (${name})`,
        framework: fw.framework,
        command: pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`,
        cwd: '',
        port: fw.port,
        source: 'package.json',
      });
    }
  } catch {
    // No package.json, or not JSON.
  }
  if (await exists(join(folder, 'manage.py')))
    out.push({
      id: 'django',
      label: 'Django',
      framework: 'Django',
      command: 'python3 manage.py runserver',
      cwd: '',
      port: 8000,
      source: 'manage.py',
    });
  let rails = await exists(join(folder, 'bin', 'rails'));
  if (!rails) {
    try {
      rails = /^\s*gem\s+["']rails["']/m.test(await readFile(join(folder, 'Gemfile'), 'utf8'));
    } catch {
      rails = false;
    }
  }
  if (rails)
    out.push({
      id: 'rails',
      label: 'Rails',
      framework: 'Rails',
      command: 'bin/rails server -b 127.0.0.1',
      cwd: '',
      port: 3000,
      source: 'rails',
    });
  if ((await exists(join(folder, 'go.mod'))) && (await exists(join(folder, 'main.go'))))
    out.push({
      id: 'go',
      label: 'Go',
      framework: 'Go',
      command: 'go run .',
      cwd: '',
      port: 8080,
      source: 'go',
    });
  return out;
}

/**
 * `.nova/launch.json`: `{"configurations": [{"name", "command", "cwd"?, "port"?}]}`. A working
 * folder must stay inside the session folder and outside protected locations.
 */
async function fromLaunchJson(folder: string): Promise<DevServerCandidateView[]> {
  let raw: string;
  try {
    raw = await readFile(join(folder, '.nova', 'launch.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const configs = (parsed as { configurations?: unknown }).configurations;
  if (!Array.isArray(configs)) return [];
  const out: DevServerCandidateView[] = [];
  for (const c of configs.slice(0, 20)) {
    const cfg = c as { name?: unknown; command?: unknown; cwd?: unknown; port?: unknown };
    if (typeof cfg.name !== 'string' || typeof cfg.command !== 'string') continue;
    const name = cfg.name.trim().slice(0, 60);
    const command = cfg.command.trim();
    if (!name || !command || command.length > 1000 || command.includes('\n')) continue;
    let cwd = typeof cfg.cwd === 'string' ? normalize(cfg.cwd).replace(/\\/g, '/') : '';
    cwd = cwd.replace(/^\.\//, '').replace(/\/+$/, '');
    if (cwd === '.') cwd = '';
    const parts = cwd.split('/').filter(Boolean);
    if (
      cwd.startsWith('/') ||
      parts.includes('..') ||
      isProtectedRel(parts) ||
      isCredentialRel(parts)
    )
      continue;
    const port =
      typeof cfg.port === 'number' &&
      Number.isInteger(cfg.port) &&
      cfg.port > 0 &&
      cfg.port < 65_536
        ? cfg.port
        : null;
    out.push({
      id: `launch:${name}`,
      label: name,
      framework: 'custom',
      command,
      cwd: parts.join('/'),
      port,
      source: 'launch.json',
    });
  }
  return out;
}

/** The command with its port set (package.json servers take it after `--`). */
function withPort(c: DevServerCandidateView, port: number): string {
  if (c.source !== 'package.json') {
    if (c.source === 'manage.py') return `${c.command} 127.0.0.1:${port}`;
    if (c.source === 'rails') return `${c.command} -p ${port}`;
    return c.command;
  }
  const fw = frameworkOf('', { [frameworkKey(c.framework)]: true });
  const args = fw.portArgs(port);
  if (!args.length) return c.command;
  const sep = c.command.startsWith('npm ') ? ' -- ' : ' ';
  return `${c.command}${sep}${args.join(' ')}`;
}

function frameworkKey(framework: string): string {
  switch (framework) {
    case 'Next.js':
      return 'next';
    case 'Nuxt':
      return 'nuxt';
    case 'Astro':
      return 'astro';
    case 'SvelteKit':
      return '@sveltejs/kit';
    case 'Vite':
      return 'vite';
    case 'Create React App':
      return 'react-scripts';
    case 'webpack':
      return 'webpack-dev-server';
    default:
      return 'node';
  }
}

function tail(output: string): string {
  return defaultRedactor.redactString(output.trim().split('\n').slice(-20).join('\n')).slice(-4000);
}
