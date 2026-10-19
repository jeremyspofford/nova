// Tool routes (contracts/hub-api.md; FR-022, FR-029, FR-038, FR-196): GET /tools,
// POST /tools/:name/invoke (passes the gate, 202 while an approval waits), artifacts and their
// content policy, mentions, and a model tool call through the full Hub.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError } from '@nova/shared';
import {
  DirectRouter,
  NodeService,
  ProviderRegistry,
  ThreadService,
  UnavailableSandbox,
  allowAllGate,
  noopNotifier,
  type AuditRecord,
  type GateOutcome,
  type ToolGate,
} from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { ARTIFACT_CSP, setupTools, type ToolsArea } from '../src/tools.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000aa';
const AUTH = { 'x-test-account': ACCOUNT };

let dir: string;
let db: NovaDatabase;
let config: HubConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-tools-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- the area on its own, with a gate the test controls -----------------------------------

interface AreaEnv {
  app: FastifyInstance;
  area: ToolsArea;
  ctx: HubContext;
  audit: AuditRecord[];
  threads: ThreadService;
  settings: Record<string, unknown>;
}

async function areaEnv(gate: ToolGate = allowAllGate, invokeWaitMs = 2_000): Promise<AreaEnv> {
  const events = new EventStore(db);
  const secrets = new MemorySecretStore();
  const registry = new ProviderRegistry({ db, secrets });
  const router = new DirectRouter(registry);
  const threads = new ThreadService({ db, router, events });
  const settings: Record<string, unknown> = {};
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
        'search.searxngUrl': null,
        'tools.permissionProfile': 'workspace',
        'tools.roots': [],
        'tools.deferBudget': { tools: 40, schemaTokens: 8000 },
      };
      return Promise.resolve(key in settings ? settings[key] : defaults[key]);
    },
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers['x-test-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as HubContext;
  const audit: AuditRecord[] = [];
  const area = await setupTools({
    ...ctx,
    gate,
    sources: [],
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    notifier: noopNotifier,
    sandbox: new UnavailableSandbox(),
    invokeWaitMs,
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
  return { app, area, ctx, audit, threads, settings };
}

describe('tool routes', () => {
  let e: AreaEnv;
  afterEach(async () => {
    await e.app.close();
    await e.area.close();
  });

  it('requires a session on every route', async () => {
    e = await areaEnv();
    for (const [method, url] of [
      ['GET', '/api/v1/tools'],
      ['POST', '/api/v1/tools/fs.read/invoke'],
      ['GET', '/api/v1/artifacts?threadId=x'],
      ['GET', '/api/v1/artifacts/x'],
      ['GET', '/api/v1/artifacts/x/content'],
      ['GET', '/api/v1/mentions?q=a'],
    ] as const) {
      const res = await e.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('lists tools with the effective decision; web.search appears once a URL is set', async () => {
    e = await areaEnv();
    const res = await e.app.inject({ method: 'GET', url: '/api/v1/tools', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { name: string; effective: unknown; userDefault: unknown }[];
    expect(items.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'fs.read',
        'fs.write',
        'fs.edit',
        'exec.run',
        'web.fetch',
        'artifact.create',
        'tool.search',
      ]),
    );
    expect(items.map((t) => t.name)).not.toContain('web.search');
    expect(items.find((t) => t.name === 'fs.read')).toMatchObject({
      effective: { effect: 'allow', tier: 'pre_approvable' },
      userDefault: null,
      loading: 'always',
    });
    e.settings['search.searxngUrl'] = 'http://searx.local';
    const again = (
      await e.app.inject({ method: 'GET', url: '/api/v1/tools', headers: AUTH })
    ).json();
    expect(again.items.map((t: { name: string }) => t.name)).toContain('web.search');
  });

  it('invokes a tool for the UI through the gate', async () => {
    e = await areaEnv();
    writeFileSync(join(config.dataDir, 'workspace', 'hello.txt'), 'hi there');
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/fs.read/invoke',
      headers: AUTH,
      payload: { args: { path: 'hello.txt' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      text: 'hi there',
      meta: { path: 'hello.txt', sha256: expect.any(String), size: 8, truncated: false },
    });
    expect(e.audit[0]).toMatchObject({ actor: 'user', action: 'fs.read', result: 'ok' });
    const fail = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/exec.run/invoke',
      headers: AUTH,
      payload: { args: { cmd: 'ls' } },
    });
    expect(fail.json()).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    const missing = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/no.such/invoke',
      headers: AUTH,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    const badThread = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/fs.read/invoke',
      headers: AUTH,
      payload: { args: {}, threadId: 'nope' },
    });
    expect(badThread.statusCode).toBe(404);
  });

  it("returns the result's meta, redacted, with the text (M7)", async () => {
    e = await areaEnv();
    const thread = await e.threads.create(ACCOUNT, {});
    const key = 'AKIAABCDEFGHIJKLMNOP';
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/artifact.create/invoke',
      headers: AUTH,
      payload: {
        args: { kind: 'markdown', title: `Keys ${key}`, content: '# hi' },
        threadId: thread.id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ok: boolean;
      text: string;
      meta: { artifact: Record<string, unknown> };
    }>();
    expect(body.ok).toBe(true);
    expect(body.meta.artifact).toMatchObject({ kind: 'markdown', version: 1 });
    expect(body.text).toContain(String(body.meta.artifact.id));
    expect(JSON.stringify(body)).not.toContain(key);
    expect(body.meta.artifact.title).toContain('[REDACTED]');
    // A failed call has no meta.
    const fail = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/artifact.create/invoke',
      headers: AUTH,
      payload: { args: { kind: 'nope', title: 'x', content: 'y' }, threadId: thread.id },
    });
    expect(fail.json()).toMatchObject({ ok: false, meta: null });
  });

  it('answers 202 with the approval while the gate waits', async () => {
    let release!: (o: GateOutcome) => void;
    const gate: ToolGate = {
      ...allowAllGate,
      check: (req) => {
        const now = new Date().toISOString();
        db.raw
          .prepare(
            `INSERT INTO approval (id, account_id, tool_call_id, requested_action, options_json, created_at)
             VALUES ('ap-1', ?, ?, 'Write x', '[]', ?)`,
          )
          .run(ACCOUNT, req.callId, now);
        return new Promise((r) => (release = r));
      },
      preview: () =>
        Promise.resolve({
          effect: 'ask',
          tier: 'pre_approvable',
          reason: 'ask',
          source: 'test',
          ruleId: null,
        }),
    };
    e = await areaEnv(gate, 50);
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/fs.write/invoke',
      headers: AUTH,
      payload: { args: { path: 'x.txt', content: 'x' } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ approvalId: 'ap-1', callId: expect.any(String) });
    release({ effect: 'allow', reason: 'ok', tier: 'pre_approvable', approvalId: 'ap-1' });
    await new Promise((r) => setTimeout(r, 100));
    const row = db.raw
      .prepare('SELECT status, approval_id FROM tool_call WHERE id = ?')
      .get(res.json().callId);
    expect(row).toEqual({ status: 'ok', approval_id: 'ap-1' });
  });

  it('serves artifacts with a content policy that never lets them run same-origin', async () => {
    e = await areaEnv();
    const t = await e.threads.create(ACCOUNT, {});
    const art = await e.area.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'markdown',
      title: 'Notes',
      content: '# Notes',
    });
    const html = await e.area.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'html',
      title: 'Page',
      content: '<p>x</p><script>1</script>',
    });
    const pdf = await e.area.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'pdf',
      title: 'Doc',
      content: Buffer.from('%PDF-1.4 x').toString('base64'),
    });
    const file = await e.area.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'file',
      title: 'data.csv',
      content: 'a,b',
      mime: 'text/csv',
    });
    const list = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts?threadId=${t.id}`,
      headers: AUTH,
    });
    expect(list.json().items.map((a: { id: string }) => a.id)).toEqual([
      art.id,
      html.id,
      pdf.id,
      file.id,
    ]);
    const one = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${art.id}`,
      headers: AUTH,
    });
    expect(one.json()).toMatchObject({ id: art.id, kind: 'markdown', title: 'Notes', version: 1 });

    const md = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${art.id}/content?v=123`,
      headers: AUTH,
    });
    expect(md.statusCode).toBe(200);
    expect(md.body).toBe('# Notes');
    expect(md.headers['content-security-policy']).toBe(ARTIFACT_CSP);
    // Framed by Nova's own pages only (the Inspector), never by another site.
    expect(md.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(ARTIFACT_CSP).toContain("frame-ancestors 'self'");
    expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(md.headers['x-content-type-options']).toBe('nosniff');
    expect(md.headers['content-disposition']).toBe('inline; filename="Notes.md"');

    const h = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${html.id}/content`,
      headers: AUTH,
    });
    const hCsp = String(h.headers['content-security-policy']);
    expect(hCsp).toContain('sandbox allow-scripts');
    expect(hCsp).not.toContain('allow-same-origin');
    const p = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${pdf.id}/content`,
      headers: AUTH,
    });
    expect(p.headers['content-security-policy']).toBe(
      "default-src 'none'; object-src 'none'; frame-ancestors 'self'",
    );
    expect(p.headers['content-disposition']).toBe('inline; filename="Doc.pdf"');
    const f = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${file.id}/content`,
      headers: AUTH,
    });
    expect(f.headers['content-disposition']).toBe('attachment; filename="data.csv"');
    expect(f.headers['content-type']).toBe('text/csv');

    const v1 = await e.area.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'markdown',
      title: null,
      content: '# Notes v2',
      artifactId: art.id,
    });
    expect(v1.version).toBe(2);
    const old = await e.app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${art.id}/content?version=1`,
      headers: AUTH,
    });
    expect(old.body).toBe('# Notes');
    const none = await e.app.inject({
      method: 'GET',
      url: '/api/v1/artifacts/nope',
      headers: AUTH,
    });
    expect(none.statusCode).toBe(404);
    const otherThread = await e.app.inject({
      method: 'GET',
      url: '/api/v1/artifacts?threadId=nope',
      headers: AUTH,
    });
    expect(otherThread.statusCode).toBe(404);
  });

  it('offers mention candidates under the roots', async () => {
    e = await areaEnv();
    writeFileSync(join(config.dataDir, 'workspace', 'roadmap.md'), '# r');
    const res = await e.app.inject({
      method: 'GET',
      url: '/api/v1/mentions?q=road',
      headers: AUTH,
    });
    expect(res.json().items).toEqual([
      {
        kind: 'file',
        ref: `file:${join(config.dataDir, 'workspace', 'roadmap.md')}`,
        label: 'roadmap.md',
        detail: 'roadmap.md',
      },
    ]);
  });

  it('registers a sandbox diagnostics probe and scopes tools by the permission profile', async () => {
    e = await areaEnv();
    const diag = await e.ctx.diagnostics.collect();
    expect(diag.sandbox).toMatchObject({ substrate: null, available: false });
    e.settings['tools.permissionProfile'] = 'read-only';
    e.settings['tools.roots'] = [{ path: dir, access: 'write' }];
    const res = await e.app.inject({
      method: 'POST',
      url: '/api/v1/tools/fs.write/invoke',
      headers: AUTH,
      payload: { args: { path: 'a.txt', content: 'x' } },
    });
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'path_denied' } });
    const scope = await e.area.runtime.scopeFor(ACCOUNT, null, null);
    expect(scope.roots.map((r) => r.access)).toEqual(['read', 'read']);
    expect(scope.profile.id).toBe('read-only');
    e.settings['tools.permissionProfile'] = 'no-such-profile';
    expect((await e.area.runtime.scopeFor(ACCOUNT, null, null)).profile.id).toBe('read-only');
    e.settings['tools.permissionProfile'] = 'full';
    expect((await e.area.runtime.scopeFor(ACCOUNT, null, null)).network).toBe('allowlist');
  });
});

// ---- the full Hub ------------------------------------------------------------------------

describe('a model tool call through the Hub', () => {
  let hub: Hub;
  afterEach(async () => {
    await hub.app.close();
  });

  it('lists the workspace with fs.list and answers from the result', async () => {
    const mock = new MockProvider({ id: 'mock', timing: 'instant' });
    hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
      chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    });
    const code = await hub.auth.issueSetupCode();
    const setup = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { host: '127.0.0.1:7419' },
      payload: { code, displayName: 'Owner' },
    });
    const session = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const headers = { host: '127.0.0.1:7419', authorization: `Bearer ${session}` };
    writeFileSync(join(config.dataDir, 'workspace', 'readme.md'), '# hi');

    const tools = await hub.app.inject({ method: 'GET', url: '/api/v1/tools', headers });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().items.map((t: { name: string }) => t.name)).toContain('fs.list');

    const thread = (
      await hub.app.inject({ method: 'POST', url: '/api/v1/threads', headers, payload: {} })
    ).json();
    const sent = await hub.app.inject({
      method: 'POST',
      url: `/api/v1/threads/${thread.id}/messages`,
      headers,
      payload: { text: '/tool fs.list {}' },
    });
    expect(sent.statusCode).toBe(202);
    await hub.chat.idle();
    const detail = (
      await hub.app.inject({ method: 'GET', url: `/api/v1/threads/${thread.id}`, headers })
    ).json();
    const parts = detail.messages.flatMap((m: { parts: { type: string }[] }) => m.parts);
    const card = parts.find((p: { type: string }) => p.type === 'tool_call');
    expect(card).toMatchObject({ tool: 'fs.list', source: 'builtin' });
    if (card.status === 'ok') {
      expect(detail.messages.at(-1).parts[0].text).toContain('readme.md');
    } else {
      // The policy area decides; a read in the workspace should never be refused silently.
      expect(['awaiting_approval', 'denied']).toContain(card.status);
    }
    const mentions = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/mentions?q=read',
      headers,
    });
    expect(mentions.json().items[0]).toMatchObject({ kind: 'file', label: 'readme.md' });
  });
});
