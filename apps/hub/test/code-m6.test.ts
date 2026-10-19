// M6 Code routes (contracts/hub-api.md "Code, tools, extensions"; FR-062, FR-067, FR-068,
// FR-070, FR-072, FR-073, FR-078, FR-097): every route needs a session; saved environments with
// health and the SSH helper's buffered output, Git hosts, pushes with their guards and pull
// requests with CI against the mock Git host, the worktree registry, dev servers, auto-verify,
// side questions, budgets, branches, and the tools and late-bound hooks the area exposes.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type SettingKey,
} from '@nova/shared';
import {
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  gitEnv,
  type AuditRecord,
  type EnvHelperConnection,
  type EnvSshTransport,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
  type StartTurnInput,
} from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupCode, type CodeArea } from '../src/code.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import {
  startMockGitHost,
  type MockGitHost,
} from '../../../packages/core/test/fixtures/githost/server.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c6';
const AUTH = { 'x-test-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let home: string;
let repo: string;
let bare: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...gitEnv({ cwd }),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
    encoding: 'utf8',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-code6-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  home = join(dir, 'home');
  repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'main.ts'), 'export const n = 1;\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  bare = join(dir, 'origin.git');
  git(['init', '-q', '--bare', '-b', 'main', bare], dir);
  git(['remote', 'add', 'origin', bare]);
  git(['push', '-q', 'origin', 'main']);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs commands on the host as the session sandbox (tests only). */
class HostBox implements SandboxClient {
  readonly substrate = 'container' as const;
  available() {
    return Promise.resolve({ ok: true, detail: 'host' });
  }
  exec(req: ExecRequest): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', req.cmd], {
        cwd: req.cwd,
        env: { ...gitEnv({ cwd: req.cwd }), ...req.env },
      });
      let output = '';
      child.stdout.on('data', (b: Buffer) => (output += b.toString('utf8')));
      child.stderr.on('data', (b: Buffer) => (output += b.toString('utf8')));
      child.on('close', (code) => resolve({ status: 'exited', exitCode: code ?? 1, output }));
    });
  }
  poll(): Promise<ExecResult> {
    return Promise.reject(new Error('no sessions'));
  }
  write() {
    return Promise.resolve();
  }
  killTurn() {
    return Promise.resolve();
  }
}

/** A `novad` helper over SSH, as a test double: one finished process with buffered output. */
function sshDouble(): EnvSshTransport & { connects: number } {
  const t = {
    connects: 0,
    connect(): Promise<EnvHelperConnection> {
      t.connects++;
      const conn: EnvHelperConnection = {
        closed: false,
        hello: () =>
          Promise.resolve({
            version: '0.6.0',
            platform: 'linux',
            arch: 'x64',
            verified: true,
            home: '/home/dev',
          }),
        stat: (p: string) => Promise.resolve(p === '/srv/app' ? { kind: 'dir' as const } : null),
        spawn: () => Promise.resolve({ id: 'p1' }),
        read: (_id: string, offset: number) =>
          Promise.resolve({
            data: 'built while you were away\n'.slice(offset),
            offset: 26,
            dropped: 0,
            running: false,
            exitCode: 0,
          }),
        write: () => Promise.resolve(),
        processes: () =>
          Promise.resolve([
            {
              id: 'p1',
              cmd: 'npm run build',
              cwd: '/srv/app',
              tag: 'session-x:turn-1',
              running: false,
              exitCode: 0,
              outputBytes: 26,
              startedAt: '2026-10-17T10:00:00.000Z',
            },
          ]),
        wslDistros: () => Promise.reject(new NovaError('capability_missing', 'not Windows')),
        wsl: () => Promise.reject(new NovaError('capability_missing', 'not Windows')),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(conn);
    },
  };
  return t;
}

interface Env {
  app: FastifyInstance;
  area: CodeArea;
  events: EventStore;
  audit: AuditRecord[];
  turns: StartTurnInput[];
  secrets: MemorySecretStore;
  ssh: ReturnType<typeof sshDouble>;
  values: Record<string, unknown>;
}

async function env(opts: { sandbox?: SandboxClient | null } = {}): Promise<Env> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const mock = new MockProvider({ id: 'mock' });
  const registry = new ProviderRegistry({
    db,
    secrets,
    factory: (input) => (input.row.provider === 'mock' ? mock : undefined),
  });
  await registry.ensureDefaultProvider(ACCOUNT);
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const values: Record<string, unknown> = {};
  const setting = (key: SettingKey) =>
    Promise.resolve(resolveSetting(key, { global: values, project: {}, managed: {} }).value);
  const ctx = {
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    events,
    secrets,
    dataDir: config.dataDir,
    registry,
    router,
    nodes: new NodeService({ db, secrets, events }),
    threads,
    setting,
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers['x-test-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const audit: AuditRecord[] = [];
  const turns: StartTurnInput[] = [];
  const ssh = sshDouble();
  const sandbox = opts.sandbox === undefined ? new HostBox() : opts.sandbox;
  const area = await setupCode({
    ...ctx,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    home,
    sandbox: () => sandbox,
    containerSandbox: () => null,
    sshTransport: ssh,
    turns: {
      startTurn: (input) => {
        turns.push(input);
        return Promise.resolve({ turnId: 't', messageId: 'm', done: new Promise(() => undefined) });
      },
      cancel: () => Promise.resolve(),
    },
  });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return { app, area, events, audit, turns, secrets, ssh, values };
}

async function done(e: Env): Promise<void> {
  await e.app.close();
  await e.area.close();
}

function client(e: Env) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    e.app.inject({
      method,
      url,
      headers: AUTH,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('M6 code routes', () => {
  it('requires a session on every new route', async () => {
    const e = await env();
    const id = '01920000-0000-7000-8000-00000000dead';
    for (const [method, url] of [
      ['POST', '/api/v1/environments'],
      ['GET', `/api/v1/environments/${id}`],
      ['PATCH', `/api/v1/environments/${id}`],
      ['DELETE', `/api/v1/environments/${id}`],
      ['POST', `/api/v1/environments/${id}/check`],
      ['GET', `/api/v1/environments/${id}/processes`],
      ['GET', `/api/v1/environments/${id}/processes/p1/output`],
      ['GET', `/api/v1/environments/wsl/distros?deviceId=${id}`],
      ['GET', '/api/v1/code/githosts'],
      ['POST', '/api/v1/code/githosts'],
      ['POST', `/api/v1/code/githosts/${id}/check`],
      ['DELETE', `/api/v1/code/githosts/${id}`],
      ['GET', '/api/v1/code/worktrees'],
      ['POST', '/api/v1/code/worktrees'],
      ['POST', `/api/v1/code/worktrees/${id}/renew`],
      ['POST', `/api/v1/code/worktrees/${id}/release`],
      ['DELETE', `/api/v1/code/worktrees/${id}`],
      ['GET', `/api/v1/code/sessions/${id}/extras`],
      ['POST', `/api/v1/code/sessions/${id}/budget/extend`],
      ['POST', `/api/v1/code/sessions/${id}/branch`],
      ['POST', `/api/v1/code/sessions/${id}/push`],
      ['POST', `/api/v1/code/sessions/${id}/pr`],
      ['GET', `/api/v1/code/sessions/${id}/pr`],
      ['POST', `/api/v1/code/sessions/${id}/pr/refresh`],
      ['GET', `/api/v1/code/sessions/${id}/devservers`],
      ['POST', `/api/v1/code/sessions/${id}/devservers`],
      ['POST', `/api/v1/code/sessions/${id}/devservers/stop-all`],
      ['POST', `/api/v1/code/sessions/${id}/devservers/${id}/stop`],
      ['GET', `/api/v1/code/sessions/${id}/verify`],
      ['POST', `/api/v1/code/sessions/${id}/verify`],
      ['GET', `/api/v1/code/sessions/${id}/verify/${id}`],
      ['POST', `/api/v1/code/sessions/${id}/ask`],
    ] as const) {
      const res = await e.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await done(e);
  });

  it('saves, checks and removes environments and reads the helper buffered output', async () => {
    const e = await env();
    const req = client(e);
    const created = await req('POST', '/api/v1/environments', {
      kind: 'ssh',
      label: 'build box',
      connection: { host: 'build.example', user: 'dev', auth: 'key' },
      credential: { privateKey: 'PRIVATE KEY MATERIAL' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('PRIVATE KEY MATERIAL');
    const v = created.json();
    expect(v).toMatchObject({ kind: 'ssh', status: 'unknown', connection: { port: 22 } });
    expect(
      (await req('POST', '/api/v1/environments', { kind: 'ssh', label: 'x', connection: {} }))
        .statusCode,
    ).toBe(400);
    const checked = await req('POST', `/api/v1/environments/${v.id}/check`);
    expect(checked.json()).toMatchObject({ status: 'ok', detail: 'novad 0.6.0 on linux (x64)' });
    const list = (await req('GET', '/api/v1/environments')).json().items;
    expect(list.map((x: { kind: string }) => x.kind)).toEqual(['local', 'ssh']);
    expect(
      (await req('PATCH', `/api/v1/environments/${v.id}`, { label: 'renamed' })).json().label,
    ).toBe('renamed');
    const procs = (await req('GET', `/api/v1/environments/${v.id}/processes`)).json().items;
    expect(procs[0]).toMatchObject({ id: 'p1', running: false, sessionId: 'session-x' });
    const out = await req('GET', `/api/v1/environments/${v.id}/processes/p1/output?offset=0`);
    expect(out.json()).toMatchObject({ data: 'built while you were away\n', offset: 26 });
    expect((await req('GET', `/api/v1/environments/wsl/distros?deviceId=${v.id}`)).statusCode).toBe(
      404,
    );
    // A session in the SSH environment.
    const s = await req('POST', '/api/v1/code/sessions', {
      folder: '/srv/app',
      environmentId: v.id,
    });
    expect(s.statusCode).toBe(201);
    expect(e.area.sandboxForThread(ACCOUNT, s.json().threadId)).not.toBeNull();
    expect((await req('DELETE', `/api/v1/environments/${v.id}`)).statusCode).toBe(409);
    const other = await req('POST', '/api/v1/environments', {
      kind: 'container',
      label: 'c',
      connection: { image: 'node:22-slim' },
    });
    expect((await req('POST', `/api/v1/environments/${other.json().id}/check`)).json().status).toBe(
      'down',
    );
    expect((await req('DELETE', `/api/v1/environments/${other.json().id}`)).statusCode).toBe(204);
    await done(e);
  });

  it('connects a Git host, guards the push, opens a pull request and follows CI', async () => {
    const host: MockGitHost = await startMockGitHost();
    host.repo('acme/app').bare = bare;
    const e = await env();
    const req = client(e);
    try {
      const h = await req('POST', '/api/v1/code/githosts', {
        kind: 'github',
        apiUrl: host.url,
        webUrl: 'https://github.example',
        token: host.token,
      });
      expect(h.statusCode).toBe(201);
      expect(h.body).not.toContain(host.token);
      expect((await req('GET', '/api/v1/code/githosts')).json().items).toHaveLength(1);
      const s = (await req('POST', '/api/v1/code/sessions', { folder: repo })).json();
      // On main: the push needs the typed branch name.
      const denied = await req('POST', `/api/v1/code/sessions/${s.id}/push`, {});
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.details).toMatchObject({ reason: 'confirmation_required' });
      expect(
        (await req('POST', `/api/v1/code/sessions/${s.id}/push`, { confirmBranch: 'main' }))
          .statusCode,
      ).toBe(200);
      // A branch, a commit, a pull request.
      const b = await req('POST', `/api/v1/code/sessions/${s.id}/branch`, { name: 'login fix' });
      expect(b.json().branch).toBe('nova/login-fix');
      writeFileSync(join(repo, 'main.ts'), 'export const n = 2;\n');
      expect(
        (
          await req('POST', `/api/v1/code/sessions/${s.id}/commit`, {
            message: 'n = 2',
            acceptPending: true,
          })
        ).statusCode,
      ).toBe(200);
      const pr = await req('POST', `/api/v1/code/sessions/${s.id}/pr`, {
        title: 'Fix login',
        repo: 'acme/app',
        hostId: h.json().id,
      });
      expect(pr.statusCode).toBe(201);
      expect(pr.json()).toMatchObject({
        number: 1,
        headBranch: 'nova/login-fix',
        ci: { status: 'none' },
      });
      expect((await req('GET', `/api/v1/code/sessions/${s.id}/pr`)).json().id).toBe(pr.json().id);
      host
        .repo('acme/app')
        .checks.set(pr.json().headSha, [
          { name: 'build', status: 'completed', conclusion: 'failure', summary: 'boom' },
        ]);
      const refreshed = await req('POST', `/api/v1/code/sessions/${s.id}/pr/refresh`);
      expect(refreshed.json().ci.status).toBe('failed');
      expect(e.turns.at(-1)).toMatchObject({ authority: { kind: 'none' }, trigger: 'event' });
      const extras = (await req('GET', `/api/v1/code/sessions/${s.id}/extras`)).json();
      expect(extras).toMatchObject({
        pullRequest: { number: 1, ci: { status: 'failed' } },
        budget: { limits: { tokens: null } },
        environment: { kind: 'local' },
      });
      expect((await req('GET', `/api/v1/code/sessions/${s.id}`)).json().ciStatus).toBe('failed');
      expect((await req('DELETE', `/api/v1/code/githosts/${h.json().id}`)).statusCode).toBe(409);
    } finally {
      await host.close();
      await done(e);
    }
  });

  it('runs the worktree registry over HTTP', async () => {
    const e = await env();
    const req = client(e);
    writeFileSync(join(repo, '.env'), 'X=1\n');
    writeFileSync(join(repo, '.worktreeinclude'), '.env\n');
    const s = (await req('POST', '/api/v1/code/sessions', { folder: repo })).json();
    const w = await req('POST', '/api/v1/code/worktrees', {
      repo,
      sessionId: s.id,
      ttlMinutes: 30,
    });
    expect(w.statusCode).toBe(201);
    expect(w.json()).toMatchObject({ leasedBy: s.id, included: 1 });
    expect(existsSync(join(w.json().path, '.env'))).toBe(true);
    const listed = (
      await req('GET', `/api/v1/code/worktrees?repo=${encodeURIComponent(repo)}`)
    ).json();
    expect(listed.items).toHaveLength(1);
    expect((await req('GET', `/api/v1/code/worktrees?deviceId=${s.id}`)).json().items).toEqual([]);
    const renewed = await req('POST', `/api/v1/code/worktrees/${w.json().id}/renew`, {
      ttlMinutes: 60,
    });
    expect(renewed.json().leaseExpiresAt).not.toBe(w.json().leaseExpiresAt);
    expect((await req('DELETE', `/api/v1/code/worktrees/${w.json().id}`)).statusCode).toBe(409);
    expect(
      (await req('POST', `/api/v1/code/worktrees/${w.json().id}/release`)).json().leasedBy,
    ).toBeNull();
    writeFileSync(join(w.json().path, 'wip.txt'), 'x');
    expect((await req('DELETE', `/api/v1/code/worktrees/${w.json().id}`)).statusCode).toBe(409);
    const removed = await req('DELETE', `/api/v1/code/worktrees/${w.json().id}?force=true`);
    expect(removed.json().status).toBe('removed');
    // A session bound to a registry worktree.
    const w2 = (await req('POST', '/api/v1/code/worktrees', { repo })).json();
    const bound = await req('POST', '/api/v1/code/sessions', { folder: repo, worktreeId: w2.id });
    expect(bound.json().worktreeId).toBe(w2.id);
    expect(
      (
        await req('POST', '/api/v1/code/sessions', {
          folder: repo,
          worktree: true,
          worktreeId: w2.id,
        })
      ).statusCode,
    ).toBe(400);
    await done(e);
  });

  it('serves dev servers, auto-verify, side questions, budgets and the tools', async () => {
    const e = await env();
    const req = client(e);
    writeFileSync(join(repo, 'manage.py'), '');
    const s = (
      await req('POST', '/api/v1/code/sessions', { folder: repo, budgets: { tokens: 50_000 } })
    ).json();
    const ds = (await req('GET', `/api/v1/code/sessions/${s.id}/devservers`)).json();
    expect(ds.candidates[0]).toMatchObject({ id: 'django', port: 8000 });
    expect(
      (await req('POST', `/api/v1/code/sessions/${s.id}/devservers/stop-all`)).json().items,
    ).toEqual([]);
    e.values['code.autoVerify'] = {
      enabled: true,
      commands: ['echo ok'],
      timeoutSeconds: 60,
      feedbackTurns: 1,
    };
    const v = await req('POST', `/api/v1/code/sessions/${s.id}/verify`);
    expect(v.statusCode).toBe(202);
    await until(
      async () =>
        (await req('GET', `/api/v1/code/sessions/${s.id}/verify/${v.json().id}`)).json().status ===
        'passed',
    );
    expect((await req('GET', `/api/v1/code/sessions/${s.id}/verify`)).json().items).toHaveLength(1);
    const ask = await req('POST', `/api/v1/code/sessions/${s.id}/ask`, {
      question: 'What changed?',
    });
    expect(ask.json().answer).toContain('What changed?');
    expect((await req('POST', `/api/v1/code/sessions/${s.id}/ask`, {})).statusCode).toBe(400);
    const b = await req('POST', `/api/v1/code/sessions/${s.id}/budget/extend`, { tokens: 10_000 });
    expect(b.json().limits.tokens).toBe(60_000);
    // The tools: Code threads get the coding and session tools, agent threads the session tools.
    const names = async (mode: 'code' | 'agent' | 'chat') =>
      (await e.area.toolsM6.list(ACCOUNT, { threadId: s.threadId, mode })).map(
        (t) => t.descriptor.name,
      );
    expect(await names('code')).toEqual(
      expect.arrayContaining(['pr.create', 'devserver.start', 'task.spawn', 'sessions.ask']),
    );
    expect(await names('code')).not.toContain('git.status');
    expect(await names('agent')).toEqual([
      'sessions.list',
      'sessions.message',
      'sessions.archive',
      'sessions.ask',
      // M7: an agent can start a Code session.
      'code.delegate',
    ]);
    expect(await names('chat')).toEqual([]);
    // Late-bound hooks of other areas.
    e.area.useDevServerGrant(() => Promise.resolve(null));
    e.area.useBrowserOpener(() => Promise.resolve());
    e.area.useDevices({ connect: () => Promise.resolve(null) });
    e.area.useSsh(e.ssh);
    expect(e.area.sandboxForThread(ACCOUNT, s.threadId)).toBeNull();
    await done(e);
  });

  it('answers 409 when no sandbox can run a dev server', async () => {
    const e = await env({ sandbox: null });
    const req = client(e);
    writeFileSync(join(repo, 'manage.py'), '');
    const s = (await req('POST', '/api/v1/code/sessions', { folder: repo })).json();
    const r = await req('POST', `/api/v1/code/sessions/${s.id}/devservers`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('sandbox_unavailable');
    expect((await req('GET', `/api/v1/code/sessions/${s.id}/pr`)).statusCode).toBe(404);
    await done(e);
  });
});
