// Workspace routes (FR-006, FR-035, FR-039, FR-041; contracts/hub-api.md): file roots, listing,
// content, raw bytes served inert, saves through the gate (200, 409 on a stale base, 202 while an
// approval waits), terminals over a WebSocket whose handshake needs a session, 409 without a
// sandbox, the library, and project folders that index into sources and become roots.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError, uuidv7 } from '@nova/shared';
import {
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  allowAllGate,
  sha256,
  type AuditRecord,
  type ExecRequest,
  type ExecResult,
  type GateOutcome,
  type GateRequest,
  type SandboxClient,
  type ToolGate,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { RAW_FILE_CSP, setupWorkspace, type WorkspaceArea } from '../src/workspace.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000b1';
const AUTH = { 'x-test-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
let repo: string;
let projectId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-ws-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  projectId = uuidv7();
  db.raw
    .prepare(
      'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(projectId, ACCOUNT, 'Proj', now, now);
  repo = join(dir, 'home', 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'main.ts'), 'export const answer = "the launch checklist";');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

class FakeSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly writes: string[] = [];
  readonly reqs: (ExecRequest & { onOutput?: (c: string) => void })[] = [];
  #exit: ((code: number) => void) | null = null;
  #gone = false;

  available() {
    return Promise.resolve({ ok: true, detail: 'fake' });
  }
  exec(req: ExecRequest): Promise<ExecResult> {
    this.reqs.push(req);
    req.signal.addEventListener('abort', () => this.#exit?.(137));
    return Promise.resolve({ status: 'running', sessionId: 's1', output: 'welcome$ ' });
  }
  poll(): Promise<ExecResult> {
    if (this.#gone) return Promise.reject(new NovaError('not_found', 'gone'));
    return new Promise((resolve) => {
      this.#exit = (code) => resolve({ status: 'exited', exitCode: code, output: '' });
    });
  }
  write(_id: string, input: { text?: string; signal?: string }): Promise<void> {
    if (input.text) {
      this.writes.push(input.text);
      this.reqs[0]?.onOutput?.(`echo:${input.text}`);
    }
    if (input.signal === 'terminate') this.#gone = true;
    return Promise.resolve();
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
  exit(code: number): void {
    this.#exit?.(code);
  }
}

interface Env {
  app: FastifyInstance;
  area: WorkspaceArea;
  audit: AuditRecord[];
  events: EventStore;
  sandbox: FakeSandbox;
  gateCalls: GateRequest[];
  url: string;
}

async function env(opts: { gate?: ToolGate; sandbox?: SandboxClient | null } = {}): Promise<Env> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const registry = new ProviderRegistry({ db, secrets });
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
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
    setting: (key: string) => {
      const defaults: Record<string, unknown> = {
        'tools.permissionProfile': 'workspace',
        'tools.roots': [],
      };
      return Promise.resolve(defaults[key]);
    },
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers['x-test-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const audit: AuditRecord[] = [];
  const gateCalls: GateRequest[] = [];
  const base = opts.gate ?? allowAllGate;
  const gate: ToolGate = {
    ...base,
    check: (req, signal) => {
      gateCalls.push(req);
      return base.check(req, signal);
    },
  };
  const sandbox = new FakeSandbox();
  const area = await setupWorkspace({
    ...ctx,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    gate,
    sandbox: () => (opts.sandbox === undefined ? sandbox : opts.sandbox),
    home: join(dir, 'home'),
  });
  const app = Fastify();
  await app.register(fastifyWebsocket);
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'validation' } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, area, audit, events, sandbox, gateCalls, url };
}

async function done(e: Env): Promise<void> {
  await e.app.close();
  await e.area.close();
}

/** Open a terminal socket; resolves with the socket once open, or how the handshake ended. */
function socket(
  e: Env,
  id: string,
  headers: Record<string, string> = AUTH,
): Promise<{ ws?: WebSocket; refused?: number; close?: number; frames: unknown[] }> {
  return new Promise((resolve) => {
    const frames: unknown[] = [];
    const ws = new WebSocket(`${e.url.replace('http', 'ws')}/api/v1/terminals/${id}/ws`, {
      headers,
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ refused: res.statusCode ?? 0, frames });
      ws.terminate();
    });
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8'))));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('close', (code) => resolve({ close: code, frames }));
    ws.on('error', () => undefined);
  });
}

/** How the server ends a terminal socket right after the upgrade. */
function closeCode(e: Env, id: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${e.url.replace('http', 'ws')}/api/v1/terminals/${id}/ws`, {
      headers: AUTH,
    });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => undefined);
  });
}

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('workspace routes', () => {
  it('requires a session on every route, including the terminal handshake', async () => {
    const e = await env();
    for (const [method, url] of [
      ['GET', '/api/v1/files/roots'],
      ['GET', '/api/v1/files/list?root=/x'],
      ['GET', '/api/v1/files/content?root=/x&path=a'],
      ['GET', '/api/v1/files/raw?root=/x&path=a'],
      ['PUT', '/api/v1/files/content'],
      ['POST', '/api/v1/terminals'],
      ['GET', '/api/v1/terminals'],
      ['DELETE', '/api/v1/terminals/x'],
      ['GET', '/api/v1/library'],
      ['GET', `/api/v1/projects/${projectId}/folders`],
      ['POST', `/api/v1/projects/${projectId}/folders`],
      ['POST', `/api/v1/projects/${projectId}/folders/x/reindex`],
      ['DELETE', `/api/v1/projects/${projectId}/folders/x`],
    ] as const) {
      const res = await e.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await socket(e, 'x', {})).toMatchObject({ refused: 401 });
    await done(e);
  });

  it('browses, reads and serves raw files inside the roots only', async () => {
    const e = await env();
    const ws = join(config.dataDir, 'workspace');
    writeFileSync(join(ws, 'page.html'), '<script>alert(1)</script>');
    const roots = await e.app.inject({ method: 'GET', url: '/api/v1/files/roots', headers: AUTH });
    expect(roots.json().items).toEqual([{ path: ws, label: 'Workspace', access: 'write' }]);
    const q = (p: string) => `root=${encodeURIComponent(ws)}&path=${encodeURIComponent(p)}`;
    const list = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/list?${q('')}`,
      headers: AUTH,
    });
    expect(list.json().items).toEqual([
      expect.objectContaining({ path: 'page.html', kind: 'file', mime: 'text/html' }),
    ]);
    const content = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/content?${q('page.html')}`,
      headers: AUTH,
    });
    expect(content.json()).toMatchObject({ text: '<script>alert(1)</script>', readOnly: false });
    const raw = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/raw?${q('page.html')}`,
      headers: AUTH,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('<script>alert(1)</script>');
    expect(raw.headers['content-security-policy']).toBe(RAW_FILE_CSP);
    expect(raw.headers['x-content-type-options']).toBe('nosniff');
    expect(raw.headers['content-type']).toBe('text/html');
    expect(raw.headers['content-disposition']).toBe('inline; filename="page.html"');
    const escape = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/content?${q('../nova.db')}`,
      headers: AUTH,
    });
    expect(escape.statusCode).toBe(403);
    const unknown = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/list?root=${encodeURIComponent(dir)}`,
      headers: AUTH,
    });
    expect(unknown.statusCode).toBe(404);
    await done(e);
  });

  it('saves through the gate, refuses stale bases and answers 202 while an approval waits', async () => {
    let release!: (o: GateOutcome) => void;
    let ask = false;
    const gate: ToolGate = {
      ...allowAllGate,
      check: (req) => {
        if (!ask) return allowAllGate.check(req, new AbortController().signal);
        db.raw
          .prepare(
            `INSERT INTO approval (id, account_id, tool_call_id, requested_action, options_json, created_at)
             VALUES ('ap-1', ?, ?, 'Save', '[]', ?)`,
          )
          .run(ACCOUNT, req.callId, new Date().toISOString());
        return new Promise((r) => (release = r));
      },
    };
    const e = await env({ gate });
    const root = join(config.dataDir, 'workspace');
    const put = (payload: Record<string, unknown>) =>
      e.app.inject({
        method: 'PUT',
        url: '/api/v1/files/content',
        headers: AUTH,
        payload: { root, ...payload },
      });
    const created = await put({ path: 'doc.md', text: 'v1', baseSha256: null });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ path: 'doc.md', sha256: sha256('v1'), text: 'v1' });
    expect(e.gateCalls[0]).toMatchObject({ origin: 'ui', tool: { name: 'fs.write' } });
    const stale = await put({ path: 'doc.md', text: 'v2', baseSha256: sha256('nope') });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'conflict' });
    const bad = await put({ path: 'doc.md' });
    expect(bad.statusCode).toBe(400);

    ask = true;
    const waiting = await put({ path: 'doc.md', text: 'v2', baseSha256: sha256('v1') });
    expect(waiting.statusCode).toBe(202);
    expect(waiting.json()).toEqual({ approvalId: 'ap-1' });
    expect(readFileSync(join(root, 'doc.md'), 'utf8')).toBe('v1');
    release({ effect: 'allow', reason: 'ok', tier: 'pre_approvable', approvalId: 'ap-1' });
    await until(() => readFileSync(join(root, 'doc.md'), 'utf8') === 'v2');
    expect(e.audit.filter((a) => a.action === 'fs.write')).toHaveLength(2);
    await done(e);
  });

  it('runs terminals over a session-checked WebSocket', async () => {
    const e = await env();
    const created = await e.app.inject({
      method: 'POST',
      url: '/api/v1/terminals',
      headers: AUTH,
      payload: { cols: 90, rows: 20 },
    });
    expect(created.statusCode).toBe(201);
    const term = created.json<{ id: string; status: string; cwd: string }>();
    expect(term).toMatchObject({ status: 'running', cwd: join(config.dataDir, 'workspace') });
    expect(e.sandbox.reqs[0]?.cmd).toContain(' 90 20;');
    const listed = await e.app.inject({ method: 'GET', url: '/api/v1/terminals', headers: AUTH });
    expect(listed.json().items).toHaveLength(1);

    const s = await socket(e, term.id);
    const ws = s.ws!;
    await until(() => s.frames.length > 0);
    expect(s.frames[0]).toEqual({ type: 'output', data: 'welcome$ ' });
    ws.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
    await until(() => s.frames.length >= 5);
    expect(e.sandbox.writes[0]).toBe('pwd\r');
    expect(e.sandbox.writes[1]).toBe('\u{10FFFD}resize;120;40\u{10FFFD}');
    expect(s.frames).toContainEqual({ type: 'output', data: 'echo:pwd\r' });
    expect(s.frames.filter((f) => (f as { type: string }).type === 'error')).toHaveLength(2);

    e.sandbox.exit(0);
    await until(() => s.frames.some((f) => (f as { type: string }).type === 'exit'));
    expect(s.frames.at(-1)).toEqual({ type: 'exit', code: 0 });
    const exited = (await e.events.since(null)).find((ev) => ev.name === 'terminal.exited');
    expect(exited?.payload).toEqual({ terminalId: term.id, code: 0 });
    ws.close();

    const closed = await e.app.inject({
      method: 'DELETE',
      url: `/api/v1/terminals/${term.id}`,
      headers: AUTH,
    });
    expect(closed.json()).toEqual({ ok: true });
    expect(await closeCode(e, term.id)).toBe(4404);
    const again = await e.app.inject({
      method: 'DELETE',
      url: `/api/v1/terminals/${term.id}`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(404);
    expect(e.audit.map((a) => a.action)).toEqual(['terminal.open', 'terminal.close']);
    await done(e);
  });

  it('answers 409 sandbox_unavailable without a sandbox', async () => {
    const e = await env({ sandbox: null });
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/terminals',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'sandbox_unavailable' });
    const bad = await e.app.inject({
      method: 'POST',
      url: '/api/v1/terminals',
      headers: AUTH,
      payload: { cols: 1 },
    });
    expect(bad.statusCode).toBe(400);
    await done(e);
  });

  it('binds project folders, indexes them into sources and adds them to the roots', async () => {
    const e = await env();
    const base = `/api/v1/projects/${projectId}/folders`;
    const refused = await e.app.inject({
      method: 'POST',
      url: base,
      headers: AUTH,
      payload: { path: config.dataDir },
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (await e.app.inject({ method: 'POST', url: base, headers: AUTH, payload: {} })).statusCode,
    ).toBe(400);
    const added = await e.app.inject({
      method: 'POST',
      url: base,
      headers: AUTH,
      payload: { path: '~/repo', access: 'write' },
    });
    expect(added.statusCode).toBe(201);
    const folder = added.json<{ id: string; status: string; path: string }>();
    expect(folder).toMatchObject({ status: 'indexing', path: repo });
    await e.area.folders.idle();
    const list = await e.app.inject({ method: 'GET', url: base, headers: AUTH });
    expect(list.json().items).toEqual([expect.objectContaining({ status: 'ready', fileCount: 1 })]);
    const indexed = (await e.events.since(null)).find((ev) => ev.name === 'project.folder.indexed');
    expect(indexed?.payload).toMatchObject({ projectId, folderId: folder.id, fileCount: 1 });

    const roots = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/roots?projectId=${projectId}`,
      headers: AUTH,
    });
    expect(roots.json().items.at(-1)).toEqual({ path: repo, label: 'repo', access: 'write' });
    const files = await e.app.inject({
      method: 'GET',
      url: `/api/v1/files/list?root=${encodeURIComponent(repo)}&path=src`,
      headers: AUTH,
    });
    expect(files.json().items.map((f: { path: string }) => f.path)).toEqual(['src/main.ts']);
    const saved = await e.app.inject({
      method: 'PUT',
      url: '/api/v1/files/content',
      headers: AUTH,
      payload: { root: repo, path: 'src/new.ts', text: 'x', baseSha256: null },
    });
    expect(saved.statusCode).toBe(200);
    expect(e.gateCalls.at(-1)).toMatchObject({ projectId });

    const re = await e.app.inject({
      method: 'POST',
      url: `${base}/${folder.id}/reindex`,
      headers: AUTH,
    });
    expect(re.json()).toMatchObject({ status: 'indexing' });
    await e.area.folders.idle();
    expect((await e.area.folders.get(ACCOUNT, projectId, folder.id)).fileCount).toBe(2);

    const lib = await e.app.inject({ method: 'GET', url: '/api/v1/library', headers: AUTH });
    expect(lib.json()).toEqual({ items: [], nextCursor: null });
    expect(
      (await e.app.inject({ method: 'GET', url: '/api/v1/library?kind=nope', headers: AUTH }))
        .statusCode,
    ).toBe(400);

    const removed = await e.app.inject({
      method: 'DELETE',
      url: `${base}/${folder.id}`,
      headers: AUTH,
    });
    expect(removed.json()).toEqual({ ok: true });
    expect((await e.app.inject({ method: 'GET', url: base, headers: AUTH })).json().items).toEqual(
      [],
    );
    await done(e);
  });
});

describe('workspace in the full Hub', () => {
  it('serves the routes to a signed-in owner, and a UI save passes the real gate', async () => {
    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html>');
    const hub = await buildHub({
      config: loadConfig({ NOVA_DATA_DIR: join(dir, 'hubdata'), NOVA_WEB_DIR: web }, []),
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    });
    const HOST = { host: '127.0.0.1:7419' };
    const unauth = await hub.app.inject({ url: '/api/v1/files/roots', headers: HOST });
    expect(unauth.statusCode).toBe(401);
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: HOST,
      payload: { code },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    const cookie = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const headers = { ...HOST, cookie: `${SESSION_COOKIE}=${cookie}` };
    const roots = (await hub.app.inject({ url: '/api/v1/files/roots', headers })).json();
    const ws = roots.items[0].path as string;
    expect(roots.items[0]).toMatchObject({ label: 'Workspace', access: 'write' });
    const save = await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/files/content',
      headers,
      payload: { root: ws, path: 'from-ui.md', text: 'typed by the user', baseSha256: null },
    });
    // A save the signed-in user makes in their own editor is the confirmation (FR-189): it runs
    // through the real gate and writes without a card.
    expect(save.statusCode, save.body).toBe(200);
    expect(readFileSync(join(ws, 'from-ui.md'), 'utf8')).toBe('typed by the user');
    await hub.app.close();
  });
});
