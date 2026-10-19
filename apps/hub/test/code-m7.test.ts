// M7 Code routes (contracts/hub-api.md "Code, tools, extensions"; FR-212, FR-213, FR-073, FR-062):
// every new route needs a session; a session handoff to another environment over HTTP (202, then
// its history), a refused one, a chat moving to a device; three-way merges with conflicts,
// markers, resolve and abort; best-of-N attempts started, compared and applied; SSH environments
// off by default, then pinning the host key on first use and refusing another (a stand-in ssh
// client runs the host here); and an agent delegating to a Code session under its rules.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  uuidv7,
  type SettingKey,
} from '@nova/shared';
import {
  DirectRouter,
  LocalTransport,
  NodeService,
  ProviderRegistry,
  ThreadService,
  gitEnv,
  type AuditRecord,
  type StartTurnInput,
  type ToolContext,
} from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupCode, type CodeArea } from '../src/code.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c7';
const AUTH = { 'x-test-account': ACCOUNT };
const FAKE_SSH = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/fake-ssh.mjs', import.meta.url),
);

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let repo: string;
let origin: string;

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

function clone(name: string): string {
  const d = join(dir, name);
  git(['clone', '-q', origin, d], dir);
  return d;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-code7-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  repo = join(dir, 'home', 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'doc.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  origin = join(dir, 'origin.git');
  git(['init', '-q', '--bare', '-b', 'main', origin], dir);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'main']);
  git(['fetch', '-q', 'origin']);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Env {
  app: FastifyInstance;
  area: CodeArea;
  events: EventStore;
  audit: AuditRecord[];
  turns: StartTurnInput[];
  values: Record<string, unknown>;
  threads: ThreadService;
  ssh: { home: string; env: Record<string, string> };
}

async function env(): Promise<Env> {
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
  const sshBin = join(dir, 'ssh');
  writeFileSync(sshBin, `#!/bin/sh\nexec node ${JSON.stringify(FAKE_SSH)} "$@"\n`, { mode: 0o755 });
  const sshHome = join(dir, 'ssh-home');
  mkdirSync(sshHome, { recursive: true });
  const sshEnv: Record<string, string> = {
    FAKE_SSH_HOST_KEY:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkQ2Rk1wqkF0b0KxZbYp1xD0p4sYgk0m2Jh9iGQ0a1b',
    FAKE_SSH_ACCEPT_KEY: 'PRIVATE KEY',
    FAKE_SSH_HOME: sshHome,
  };
  const area = await setupCode({
    ...ctx,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    home: join(dir, 'home'),
    sandbox: () => null,
    containerSandbox: () => null,
    handoffTurnWaitMs: 1_000,
    sshClient: { bin: sshBin, env: sshEnv, multiplex: false },
    turns: {
      startTurn: (input) => {
        turns.push(input);
        return Promise.resolve({ turnId: 't', messageId: 'm', done: new Promise(() => undefined) });
      },
      cancel: () => Promise.resolve(),
    },
  });
  area.useEnvironmentTransport('cloud', () =>
    Promise.resolve(
      new LocalTransport({ label: 'the cloud runner', stateDir: join(dir, 'cloud-state') }),
    ),
  );
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
  return { app, area, events, audit, turns, values, threads, ssh: { home: sshHome, env: sshEnv } };
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

// Handoffs run dozens of git processes: 0.7 s alone, over 10 s when every package tests at once.
async function until(fn: () => boolean | Promise<boolean>, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function cloudEnv(): string {
  const id = uuidv7();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO environment (id, account_id, kind, label, config_json, status, created_at,
         updated_at) VALUES (?, ?, 'cloud', 'cloud runner', '{}', 'ok', ?, ?)`,
    )
    .run(id, ACCOUNT, now, now);
  return id;
}

describe('M7 code routes', () => {
  it('requires a session on every new route', async () => {
    const e = await env();
    const id = '01920000-0000-7000-8000-00000000dead';
    for (const [method, url] of [
      ['POST', `/api/v1/code/sessions/${id}/handoff`],
      ['GET', `/api/v1/code/sessions/${id}/handoffs`],
      ['GET', `/api/v1/handoffs/${id}`],
      ['POST', `/api/v1/threads/${id}/handoff`],
      ['POST', `/api/v1/code/sessions/${id}/merge`],
      ['GET', `/api/v1/code/sessions/${id}/merges`],
      ['GET', `/api/v1/code/sessions/${id}/merges/${id}`],
      ['POST', `/api/v1/code/sessions/${id}/merges/${id}/resolve`],
      ['POST', `/api/v1/code/sessions/${id}/merges/${id}/abort`],
      ['POST', `/api/v1/code/sessions/${id}/attempts`],
      ['GET', `/api/v1/code/sessions/${id}/attempts`],
      ['GET', `/api/v1/code/attempts/${id}`],
      ['POST', `/api/v1/code/attempts/${id}/apply`],
      ['POST', `/api/v1/code/attempts/${id}/discard`],
      ['POST', `/api/v1/environments/${id}/hostkey/reset`],
    ] as const) {
      const res = await e.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await done(e);
  });

  it('hands a session off over HTTP, records refusals and moves a chat to a device', async () => {
    const e = await env();
    const req = client(e);
    const cloud = cloudEnv();
    const target = clone('cloud-checkout');
    const s = (await req('POST', '/api/v1/code/sessions', { folder: repo })).json<{ id: string }>();
    writeFileSync(join(repo, 'doc.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\n');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 255, 1, 254]));
    expect(
      (await req('POST', `/api/v1/code/sessions/${s.id}/handoff`, { to: {} })).statusCode,
    ).toBe(400);
    const started = await req('POST', `/api/v1/code/sessions/${s.id}/handoff`, {
      to: { environmentId: cloud, folder: target },
    });
    expect(started.statusCode).toBe(202);
    const h = started.json<{ id: string; status: string }>();
    expect(h.status).toBe('pending');
    await until(
      async () =>
        (await req('GET', `/api/v1/handoffs/${h.id}`)).json<{ status: string }>().status !==
          'pending' &&
        (await req('GET', `/api/v1/handoffs/${h.id}`)).json<{ status: string }>().status !==
          'running',
    );
    expect((await req('GET', `/api/v1/handoffs/${h.id}`)).json()).toMatchObject({
      status: 'completed',
    });
    expect(readFileSync(join(target, 'doc.txt'), 'utf8')).toContain('TWO');
    expect([...readFileSync(join(target, 'bin.dat'))]).toEqual([0, 255, 1, 254]);
    const session = (await req('GET', `/api/v1/code/sessions/${s.id}`)).json<{
      environmentId: string;
      folder: { path: string };
    }>();
    expect(session).toMatchObject({ environmentId: cloud, folder: { path: target } });
    // Back to the Hub's checkout, which still has the kept changes: refused and recorded.
    const local = (await req('GET', '/api/v1/environments'))
      .json<{ items: { id: string; kind: string }[] }>()
      .items.find((x) => x.kind === 'local')!.id;
    const back = (
      await req('POST', `/api/v1/code/sessions/${s.id}/handoff`, {
        to: { environmentId: local, folder: repo },
      })
    ).json<{ id: string }>();
    await until(
      async () =>
        (await req('GET', `/api/v1/handoffs/${back.id}`)).json<{ status: string }>().status ===
        'refused',
    );
    expect((await req('GET', `/api/v1/handoffs/${back.id}`)).json()).toMatchObject({
      reason: 'target_dirty',
    });
    const history = (await req('GET', `/api/v1/code/sessions/${s.id}/handoffs`)).json<{
      items: { id: string }[];
    }>();
    expect(history.items.map((x) => x.id)).toEqual([back.id, h.id]);
    // A chat moves to one of the account's devices.
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key,
           roles, status, created_at, updated_at)
         VALUES ('dev-7', ?, 'Phone', 'client', 'ios', 'fp-7', 'pk', '[]', 'active', ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    const chat = await e.threads.create(ACCOUNT, { mode: 'chat', title: 'ideas' });
    const moved = await req('POST', `/api/v1/threads/${chat.id}/handoff`, {
      to: { deviceId: 'dev-7' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      status: 'completed',
      to: 'device:dev-7',
      toLabel: 'Phone',
    });
    expect(
      (await req('POST', `/api/v1/threads/${chat.id}/handoff`, { to: { deviceId: 'x' } }))
        .statusCode,
    ).toBe(404);
    await done(e);
  }, 60_000);

  it('merges a patch with conflicts surfaced, resolved and aborted', async () => {
    const e = await env();
    const req = client(e);
    const base = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repo, 'doc.txt'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n');
    const patch = git(['diff', '--binary', '--full-index']);
    git(['checkout', '-q', '--', '.']);
    writeFileSync(join(repo, 'doc.txt'), 'one\ntwo\nthree!\nfour\nfive\nsix\n');
    git(['commit', '-qam', 'moved']);
    const s = (await req('POST', '/api/v1/code/sessions', { folder: repo })).json<{ id: string }>();
    const refused = await req('POST', `/api/v1/code/sessions/${s.id}/merge`, {
      from: { patch, base },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'merge_conflict',
    );
    const marked = await req('POST', `/api/v1/code/sessions/${s.id}/merge`, {
      from: { patch, base },
      onConflict: 'markers',
    });
    expect(marked.statusCode).toBe(201);
    const m = marked.json<{ id: string; status: string; conflicts: { path: string }[] }>();
    expect(m.status).toBe('conflicted');
    expect(m.conflicts[0]?.path).toBe('doc.txt');
    expect(
      (await req('POST', `/api/v1/code/sessions/${s.id}/merges/${m.id}/resolve`)).statusCode,
    ).toBe(409);
    const aborted = await req('POST', `/api/v1/code/sessions/${s.id}/merges/${m.id}/abort`);
    expect(aborted.json()).toMatchObject({ status: 'aborted' });
    expect(readFileSync(join(repo, 'doc.txt'), 'utf8')).toContain('three!');
    const list = (await req('GET', `/api/v1/code/sessions/${s.id}/merges`)).json<{
      items: unknown[];
    }>();
    expect(list.items).toHaveLength(2);
    expect((await req('GET', `/api/v1/code/sessions/${s.id}/merges/${m.id}`)).json()).toMatchObject(
      {
        status: 'aborted',
      },
    );
    await done(e);
  });

  it('starts attempts, compares them and applies one', async () => {
    const e = await env();
    const req = client(e);
    const s = (await req('POST', '/api/v1/code/sessions', { folder: repo })).json<{ id: string }>();
    expect(
      (await req('POST', `/api/v1/code/sessions/${s.id}/attempts`, { objective: 'x', count: 9 }))
        .statusCode,
    ).toBe(400);
    const started = await req('POST', `/api/v1/code/sessions/${s.id}/attempts`, {
      objective: 'Add a changelog',
      count: 2,
    });
    expect(started.statusCode).toBe(201);
    const set = started.json<{ id: string; attempts: { id: string; sessionId: string }[] }>();
    expect(set.attempts).toHaveLength(2);
    expect(e.turns).toHaveLength(2);
    const a0 = (await req('GET', `/api/v1/code/sessions/${set.attempts[0]!.sessionId}`)).json<{
      folder: { path: string };
    }>();
    writeFileSync(join(a0.folder.path, 'CHANGELOG.md'), '# Changes\n');
    const view = (await req('GET', `/api/v1/code/attempts/${set.id}`)).json<{
      attempts: { files: { path: string }[]; patch: string }[];
    }>();
    expect(view.attempts[0]!.files.map((f) => f.path)).toEqual(['CHANGELOG.md']);
    expect(view.attempts[0]!.patch).toContain('+# Changes');
    expect(
      (await req('GET', `/api/v1/code/sessions/${s.id}/attempts`)).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(1);
    const applied = await req('POST', `/api/v1/code/attempts/${set.id}/apply`, {
      attemptId: set.attempts[0]!.id,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      set: { status: 'applied' },
      merge: { status: 'applied' },
    });
    expect(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')).toBe('# Changes\n');
    const second = (
      await req('POST', `/api/v1/code/sessions/${s.id}/attempts`, { objective: 'y' })
    ).json<{ id: string }>();
    expect((await req('POST', `/api/v1/code/attempts/${second.id}/discard`)).json()).toMatchObject({
      status: 'discarded',
    });
    await done(e);
    // Three worktrees and a merge: about 40 git processes, slow when every package tests at once.
  }, 30_000);

  it('keeps SSH off by default, then pins the host key on first use and refuses another', async () => {
    const e = await env();
    const req = client(e);
    const created = (
      await req('POST', '/api/v1/environments', {
        kind: 'ssh',
        label: 'box',
        connection: { host: 'build.example', user: 'dev', auth: 'key' },
        credential: { privateKey: 'PRIVATE KEY' },
      })
    ).json<{ id: string }>();
    const off = (await req('POST', `/api/v1/environments/${created.id}/check`)).json<{
      status: string;
      detail: string;
    }>();
    expect(off).toMatchObject({ status: 'down' });
    expect(off.detail).toContain('code.ssh.enabled');
    e.values['code.ssh.enabled'] = true;
    const on = (await req('POST', `/api/v1/environments/${created.id}/check`)).json<{
      status: string;
      connection: { hostKey: string | null };
    }>();
    expect(on.status).toBe('ok');
    expect(on.connection.hostKey).toBe(e.ssh.env.FAKE_SSH_HOST_KEY);
    expect(e.audit.some((a) => a.action === 'environment.hostkey.pinned')).toBe(true);
    e.ssh.env.FAKE_SSH_HOST_KEY =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBk3Zz8YpQm2v6oVqKxNw3cL1fTt0aRZsQe8yHn4Jw7c';
    const changed = (await req('POST', `/api/v1/environments/${created.id}/check`)).json<{
      status: string;
      detail: string;
    }>();
    expect(changed.status).toBe('down');
    expect(changed.detail).toContain('pinned key');
    // The owner re-pins on purpose; the next check pins the key the host presents now.
    const reset = await req('POST', `/api/v1/environments/${created.id}/hostkey/reset`);
    expect(reset.json()).toMatchObject({ connection: { hostKey: null } });
    expect(e.audit.some((a) => a.action === 'environment.hostkey.reset')).toBe(true);
    const again = (await req('POST', `/api/v1/environments/${created.id}/check`)).json<{
      status: string;
      connection: { hostKey: string | null };
    }>();
    expect(again).toMatchObject({
      status: 'ok',
      connection: { hostKey: e.ssh.env.FAKE_SSH_HOST_KEY },
    });
    await done(e);
  }, 60_000);

  it('lets an agent delegate to a Code session under its rules', async () => {
    const e = await env();
    const agentThread = (await e.threads.create(ACCOUNT, { mode: 'chat', title: 'agent' })).id;
    e.area.useAgents({
      agentOf: (_a, t) =>
        Promise.resolve(
          t === agentThread ? { agentId: 'ag-7', kind: 'main', audience: 'private' } : null,
        ),
      mainThread: () => Promise.resolve(agentThread),
    });
    const now = new Date().toISOString();
    const pid = uuidv7();
    db.raw
      .prepare(
        'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(pid, ACCOUNT, 'p', now, now);
    db.raw
      .prepare(
        'INSERT INTO project_folder (id, project_id, path, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(uuidv7(), pid, repo, 'write', now, now);
    const tools = await e.area.toolsM6.list(ACCOUNT, { threadId: agentThread, mode: 'agent' });
    const delegate = tools.find((t) => t.descriptor.name === 'code.delegate')!;
    const r = await delegate.handler({ projectId: pid, objective: 'Tidy the docs' }, {
      accountId: ACCOUNT,
      threadId: agentThread,
    } as ToolContext);
    expect(r.ok).toBe(true);
    const sessionId = String(r.ok ? r.meta?.sessionId : '');
    const info = e.area.service.info(ACCOUNT, sessionId);
    expect(info).toMatchObject({ folder: repo, permissionMode: 'manual' });
    const rules = e.area.delegatedRules({
      forThread: (_a, t) =>
        Promise.resolve(
          t === agentThread
            ? {
                rules: [
                  {
                    id: 'r1',
                    scope: { kind: 'thread' as const, ref: agentThread },
                    match: { tool: ['exec.run'] },
                    effect: 'deny' as const,
                  },
                ],
                commandRules: [],
              }
            : null,
        ),
    });
    const forSession = await rules.forThread(ACCOUNT, info.threadId);
    expect(forSession?.rules[0]).toMatchObject({
      effect: 'deny',
      scope: { kind: 'thread', ref: info.threadId },
    });
    expect(e.audit.some((a) => a.action === 'code.delegate' && a.actor === 'agent:ag-7')).toBe(
      true,
    );
    // The agents area's events hold, release and cancel the delegated work.
    const held = async () =>
      ((await rules.forThread(ACCOUNT, info.threadId))?.rules ?? []).some((r) =>
        r.id.startsWith('delegation-held:'),
      );
    await e.events.emit({
      name: 'agent.status.changed',
      actor: 'user',
      accountId: ACCOUNT,
      payload: { agentId: 'ag-7', from: 'active', to: 'paused' },
    });
    await until(held);
    expect(e.audit.some((a) => a.action === 'code.delegation.held')).toBe(true);
    await e.events.emit({
      name: 'agent.status.changed',
      actor: 'user',
      accountId: ACCOUNT,
      payload: { agentId: 'ag-7', from: 'paused', to: 'active' },
    });
    await until(async () => !(await held()));
    await e.events.emit({
      name: 'agent.deleted',
      actor: 'user',
      accountId: ACCOUNT,
      payload: { agentId: 'ag-7' },
    });
    await until(() => !e.area.service.info(ACCOUNT, sessionId).active);
    expect(e.audit.some((a) => a.action === 'code.delegation.cancelled')).toBe(true);
    await done(e);
  });
});
