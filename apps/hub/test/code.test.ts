// Code session routes (FR-061, FR-063..FR-066, FR-069, FR-074, FR-211; contracts/hub-api.md):
// every route needs a session; sessions, environments, changes with per-hunk and whole-file
// decisions, comments, the review, commits, symbols and the terminal binding over HTTP; a tool
// call on a code thread refreshes the changes with its call id; the folder's mode is saved in
// `code.folderModes`; a repository hook never runs for Nova's own Git calls (J6 step 5).
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
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
  type StartTurnInput,
  type TerminalManager,
} from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { setupCode, type CodeArea } from '../src/code.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';
const AUTH = { 'x-test-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let home: string;
let repo: string;
let marker: string;

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
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-code-'));
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
  writeFileSync(
    join(repo, 'main.ts'),
    Array.from({ length: 20 }, (_, i) => `export const n${i} = ${i};`).join('\n') + '\n',
  );
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  // J6 step 5: a hook that writes a marker whenever Git runs it.
  marker = join(dir, 'hook-ran');
  for (const hook of [
    'pre-commit',
    'post-checkout',
    'post-commit',
    'reference-transaction',
    'post-index-change',
  ]) {
    const p = join(repo, '.git', 'hooks', hook);
    writeFileSync(p, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
    chmodSync(p, 0o755);
  }
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
}

async function env(opts: { reviewReply?: string } = {}): Promise<Env> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const mock = new MockProvider({
    id: 'mock',
    scripts: opts.reviewReply
      ? [{ when: 'Review this diff', steps: [{ textChunks: [opts.reviewReply] }] }]
      : [],
  });
  const registry = new ProviderRegistry({
    db,
    secrets,
    factory: (input) => (input.row.provider === 'mock' ? mock : undefined),
  });
  await registry.ensureDefaultProvider(ACCOUNT);
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const setting = (key: SettingKey) => {
    const rows = db.raw
      .prepare("SELECT key, value_json AS v FROM setting WHERE scope_kind = 'global'")
      .all() as { key: string; v: string }[];
    const global: Record<string, unknown> = {};
    for (const r of rows) global[r.key] = JSON.parse(r.v) as unknown;
    return Promise.resolve(resolveSetting(key, { global, project: {}, managed: {} }).value);
  };
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
  const area = await setupCode({
    ...ctx,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    home,
    turns: {
      startTurn: (input) => {
        turns.push(input);
        return Promise.resolve({ turnId: 't', messageId: 'm', done: new Promise(() => undefined) });
      },
      cancel: () => Promise.resolve(),
    },
    terminals: {
      create: (_a: string, input: { root?: string }) =>
        Promise.resolve({ id: 'term-1', cwd: input.root, status: 'running' }),
    } as unknown as TerminalManager,
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
  return { app, area, events, audit, turns };
}

async function done(e: Env): Promise<void> {
  await e.app.close();
  await e.area.close();
}

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('code routes', () => {
  it('requires a session on every route', async () => {
    const e = await env();
    const id = '01920000-0000-7000-8000-00000000dead';
    for (const [method, url] of [
      ['GET', '/api/v1/environments'],
      ['GET', '/api/v1/code/sessions'],
      ['POST', '/api/v1/code/sessions'],
      ['GET', `/api/v1/code/sessions/${id}`],
      ['PATCH', `/api/v1/code/sessions/${id}`],
      ['GET', `/api/v1/code/sessions/${id}/changes`],
      ['POST', `/api/v1/code/sessions/${id}/changes/${id}/hunks`],
      ['POST', `/api/v1/code/sessions/${id}/changes/accept`],
      ['POST', `/api/v1/code/sessions/${id}/changes/reject`],
      ['GET', `/api/v1/code/sessions/${id}/comments`],
      ['POST', `/api/v1/code/sessions/${id}/comments`],
      ['POST', `/api/v1/code/sessions/${id}/comments/${id}/resolve`],
      ['POST', `/api/v1/code/sessions/${id}/review`],
      ['GET', `/api/v1/code/sessions/${id}/reviews/${id}`],
      ['POST', `/api/v1/code/sessions/${id}/commit`],
      ['GET', `/api/v1/code/sessions/${id}/symbols`],
      ['GET', `/api/v1/code/sessions/${id}/refs?name=x`],
      ['POST', `/api/v1/code/sessions/${id}/terminal`],
    ] as const) {
      const res = await e.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await done(e);
  });

  it('runs a session end to end: create, diff, decide, comment, review, commit (J6)', async () => {
    const reply = JSON.stringify([
      { path: 'main.ts', line: 2, severity: 'warn', title: 'Check this', reasoning: 'Because.' },
    ]);
    const e = await env({ reviewReply: reply });
    const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
      e.app.inject({
        method,
        url,
        headers: AUTH,
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });

    const envs = await req('GET', '/api/v1/environments');
    expect(envs.json().items[0]).toMatchObject({ kind: 'local' });
    expect(
      (await req('POST', '/api/v1/code/sessions', { folder: join(home, 'nope') })).statusCode,
    ).toBe(400);
    expect((await req('POST', '/api/v1/code/sessions', { folder: '/etc' })).statusCode).toBe(403);
    expect(
      (await req('POST', '/api/v1/code/sessions', { folder: repo, extra: 1 })).statusCode,
    ).toBe(400);
    const created = await req('POST', '/api/v1/code/sessions', {
      folder: repo,
      permissionMode: 'accept_edits',
    });
    expect(created.statusCode).toBe(201);
    const s = created.json();
    expect(s).toMatchObject({ permissionMode: 'accept_edits', repo: { branch: 'main' } });
    // The folder's mode is saved as a setting and announced.
    const saved = db.raw
      .prepare("SELECT value_json AS v FROM setting WHERE key = 'code.folderModes'")
      .get() as { v: string };
    expect(JSON.parse(saved.v)).toEqual({ [repo]: 'accept_edits' });
    expect((await req('GET', '/api/v1/code/sessions')).json().items).toHaveLength(1);
    expect((await req('GET', `/api/v1/code/sessions/${s.id}`)).json().id).toBe(s.id);
    const patched = await req('PATCH', `/api/v1/code/sessions/${s.id}`, {
      permissionMode: 'manual',
    });
    expect(patched.json().permissionMode).toBe('manual');
    expect(e.audit.some((a) => a.action === 'code.mode.changed')).toBe(true);
    expect((await req('PATCH', `/api/v1/code/sessions/${s.id}`, {})).statusCode).toBe(400);
    expect((await e.area.policy.forThread(ACCOUNT, s.threadId))?.approvalPolicy).toBe('ask_always');

    // The agent edits two places (a tool call); the completed call refreshes with its id.
    const lines = readFileSync(join(repo, 'main.ts'), 'utf8').split('\n');
    lines[1] = 'export const n1 = 100;';
    lines[17] = 'export const n17 = 1700;';
    writeFileSync(join(repo, 'main.ts'), lines.join('\n'));
    await e.events.emit({
      name: 'tool.call.completed',
      accountId: ACCOUNT,
      payload: { callId: 'call-7', tool: 'fs.edit', status: 'ok', threadId: s.threadId },
    });
    await until(() => db.raw.prepare('SELECT 1 FROM code_change').get() !== undefined);
    const changes = (await req('GET', `/api/v1/code/sessions/${s.id}/changes`)).json().items;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'main.ts', callId: 'call-7', state: 'pending' });
    expect(changes[0].hunks.map((h: { id: string }) => h.id)).toEqual(['1-1', '15-15']);

    const half = await req('POST', `/api/v1/code/sessions/${s.id}/changes/${changes[0].id}/hunks`, {
      decisions: [{ hunkId: '1-1', accept: true }],
    });
    expect(half.json()).toMatchObject({ state: 'partial' });
    const stale = await req(
      'POST',
      `/api/v1/code/sessions/${s.id}/changes/${changes[0].id}/hunks`,
      {
        decisions: [{ hunkId: '1-1', accept: true }],
      },
    );
    expect(stale.statusCode).toBe(409);

    // A comment batch goes to the agent with the user's authority.
    const comments = await req('POST', `/api/v1/code/sessions/${s.id}/comments`, {
      comments: [{ changeId: changes[0].id, line: 18, side: 'new', body: 'Make it 1800' }],
      submit: true,
    });
    expect(comments.statusCode).toBe(201);
    expect(e.turns[0]).toMatchObject({ threadId: s.threadId, authority: { kind: 'user' } });
    const commentId = comments.json().items[0].id;
    expect(
      (await req('POST', `/api/v1/code/sessions/${s.id}/comments/${commentId}/resolve`)).json()
        .resolved,
    ).toBe(true);
    expect((await req('GET', `/api/v1/code/sessions/${s.id}/comments`)).json().items).toHaveLength(
      1,
    );

    // Review: running at once, findings later, added as comments.
    const started = await req('POST', `/api/v1/code/sessions/${s.id}/review`, {});
    expect(started.statusCode).toBe(202);
    expect(started.json().status).toBe('running');
    let review = started.json();
    for (let i = 0; i < 100 && review.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      review = (
        await req('GET', `/api/v1/code/sessions/${s.id}/reviews/${started.json().id}`)
      ).json();
    }
    expect(review).toMatchObject({
      status: 'done',
      findings: [{ title: 'Check this', severity: 'warn' }],
    });
    const all = (await req('GET', `/api/v1/code/sessions/${s.id}/comments`)).json().items;
    expect(all.map((c: { author: string }) => c.author).sort()).toEqual(['review', 'user']);

    // Reject the rest, then commit on a new branch.
    const rejected = await req('POST', `/api/v1/code/sessions/${s.id}/changes/reject`, {});
    expect(rejected.json().items[0]).toMatchObject({ state: 'partial' });
    expect(readFileSync(join(repo, 'main.ts'), 'utf8')).toContain('n17 = 17;');
    const refused = await req('POST', `/api/v1/code/sessions/${s.id}/commit`, {
      message: 'Tune n1',
    });
    expect(refused.statusCode).toBe(403);
    const committed = await req('POST', `/api/v1/code/sessions/${s.id}/commit`, {
      message: 'Tune n1',
      branch: 'tune',
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({ branch: 'nova/tune', files: 1, hooksRan: false });
    expect(committed.json().hooksNote).toMatch(/hooks did not run/);
    expect(git(['log', '-1', '--format=%s'])).toBe('Tune n1\n');
    // J6 step 5: Nova's status, diff, branch and commit calls never ran the hook.
    expect(existsSync(marker)).toBe(false);

    const symbols = await req('GET', `/api/v1/code/sessions/${s.id}/symbols?q=n1`);
    expect(symbols.json().items[0]).toMatchObject({ name: 'n1', path: 'main.ts', line: 2 });
    const refs = await req('GET', `/api/v1/code/sessions/${s.id}/refs?name=n17`);
    expect(refs.json().items).toEqual([
      { path: 'main.ts', line: 18, text: 'export const n17 = 17;' },
    ]);
    const term = await req('POST', `/api/v1/code/sessions/${s.id}/terminal`, {
      cols: 120,
      rows: 40,
    });
    expect(term.statusCode).toBe(201);
    expect(term.json()).toMatchObject({ id: 'term-1', cwd: repo });
    await done(e);
  });

  it('accepts everything, offers the coding tools and the turn extension', async () => {
    const e = await env();
    const s = (
      await e.app.inject({
        method: 'POST',
        url: '/api/v1/code/sessions',
        headers: AUTH,
        payload: { folder: repo },
      })
    ).json();
    writeFileSync(join(repo, 'new.ts'), 'export const fresh = 1;\n');
    const accepted = await e.app.inject({
      method: 'POST',
      url: `/api/v1/code/sessions/${s.id}/changes/accept`,
      headers: AUTH,
      payload: {},
    });
    expect(accepted.json().items).toEqual([
      expect.objectContaining({ path: 'new.ts', state: 'accepted' }),
    ]);
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: `/api/v1/code/sessions/${s.id}/changes/accept`,
          headers: AUTH,
          payload: { changeIds: [] },
        })
      ).statusCode,
    ).toBe(400);
    const names = (await e.area.tools.list(ACCOUNT)).map((t) => t.descriptor.name);
    expect(names).toEqual([
      'git.status',
      'git.diff',
      'git.log',
      'test.run',
      'code.symbols',
      'code.refs',
    ]);
    const add = await e.area.extension.forTurn({
      accountId: ACCOUNT,
      threadId: s.threadId,
      turnId: 't',
      mode: 'code',
      trigger: 'user',
      projectId: null,
    });
    expect(add?.context?.[0]?.label).toBe('Environment');
    expect(await e.area.status.blocked(ACCOUNT, [s.threadId])).toEqual(new Map());
    // Read-only tool calls do not refresh.
    await e.events.emit({
      name: 'tool.call.completed',
      accountId: ACCOUNT,
      payload: { callId: 'c', tool: 'fs.read', status: 'ok', threadId: s.threadId },
    });
    const terminal = await e.app.inject({
      method: 'POST',
      url: `/api/v1/code/sessions/${s.id}/terminal`,
      headers: AUTH,
      payload: { cols: 3 },
    });
    expect(terminal.statusCode).toBe(400);
    expect(SETTINGS['code.permissionMode'].default).toBe('manual');
    await done(e);
  });
});
