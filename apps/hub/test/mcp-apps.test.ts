// MCP Apps in the Hub (FR-198): entry points from enabled plugins and MCP servers with stable
// ids, the `ui://` resource served with its CSP (declared domains intersected with the network
// permissions, never same-origin), clear 404s for missing and failing resources, model context
// per thread (untrusted, bounded), and session checks through the full Hub.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { NovaError, httpStatusFor, isNovaError, uuidv7, type UiEntryPointView } from '@nova/shared';
import { migrate, openDatabase, schema, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { setupMcp, type HubMcpArea } from '../src/mcp.ts';
import {
  APP_CSP_BASE,
  MODEL_CONTEXT_MAX_CHARS,
  UiContextStore,
  allowedSources,
  appCsp,
  entryPointId,
  pluginUiFromManifest,
  setupMcpApps,
  type McpAppsArea,
  type PluginUi,
  type UiResourceReader,
} from '../src/mcp-apps.ts';

const BOARD_HTML = '<!doctype html><title>Board</title><script>window.ready = 1;</script>';
const HOST = { host: '127.0.0.1:7419' };

const MANIFEST = {
  schemaVersion: 1,
  id: 'com.example.sample',
  name: 'Sample',
  version: '1.0.0',
  permissions: {
    network: ['api.example.com', '*.cdn.example.net'],
    ui: {
      connectDomains: ['https://api.example.com', 'https://evil.example.org', "'self'"],
      resourceDomains: ['img.cdn.example.net', "'unsafe-eval'", 'data:', '*'],
      frameDomains: ['https://frames.example.org'],
    },
  },
  ui: {
    entryPoints: [
      { kind: 'thread', resource: 'ui://widgets/board.html', title: 'Board' },
      { kind: 'global', resource: 'ui://widgets/missing.html', title: 'Missing' },
      {
        kind: 'file',
        resource: 'ui://widgets/board.html',
        title: 'CSV board',
        extensions: ['.csv'],
      },
    ],
  },
};

/** An MCP server with UI resources, served over streamable HTTP from this process. */
async function startUiServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const build = () => {
    const s = new McpServer({ name: 'widgets', version: '1.0.0' });
    s.registerResource(
      'board',
      'ui://widgets/board.html',
      { title: 'Board', mimeType: 'text/html;profile=mcp-app' },
      (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: BOARD_HTML }],
      }),
    );
    s.registerResource('readme', 'note://readme', { mimeType: 'text/plain' }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'not an app' }],
    }));
    s.registerResource('broken', 'ui://widgets/broken.html', { mimeType: 'text/html' }, () => {
      throw new Error('the widget store is offline <b>now</b>');
    });
    return s;
  };
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  async function handle(req: IncomingMessage): Promise<Response> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    let body: string | undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = Buffer.concat(chunks).toString('utf8');
    }
    const sid = headers.get('mcp-session-id');
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid) return new Response('unknown session', { status: 404 });
      const t = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, t),
      });
      await build().connect(t);
      transport = t;
    }
    return transport.handleRequest(
      new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
      }),
    );
  }
  const server: Server = createServer((req, res) => {
    handle(req)
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const reader = response.body.getReader();
          res.on('close', () => void reader.cancel().catch(() => undefined));
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      for (const t of sessions.values()) await t.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let dir: string;
let db: NovaDatabase;
let config: HubConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-apps-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CSP building and domain intersection', () => {
  it('keeps only declared hosts the network permissions cover', () => {
    expect(
      allowedSources(
        [
          'https://api.example.com',
          'api.example.com:8443',
          'wss://live.example.com',
          '*.api.example.com',
          'img.cdn.example.net',
          '*.cdn.example.net',
          'cdn.example.net',
          'https://evil.example.org',
        ],
        ['api.example.com', 'live.example.com', '*.cdn.example.net', '*.api.example.com'],
      ),
    ).toEqual([
      'https://api.example.com',
      'https://api.example.com:8443',
      'wss://live.example.com',
      'https://*.api.example.com',
      'https://img.cdn.example.net',
      'https://*.cdn.example.net',
    ]);
  });

  it('drops keywords, wildcards, schemes and paths so metadata cannot widen the policy', () => {
    const bad = [
      "'self'",
      "'unsafe-eval'",
      '*',
      'data:',
      'blob:',
      'javascript:alert(1)',
      'https://api.example.com/path',
      'api.example.com; script-src *',
      'ftp://api.example.com',
      '',
    ];
    expect(allowedSources(bad, ['api.example.com', '*'])).toEqual([]);
    // No network permissions: nothing external, whatever is declared.
    expect(allowedSources(['https://api.example.com'], [])).toEqual([]);
  });

  it('builds the base policy and adds allowed sources per directive', () => {
    const base = appCsp({ connect: [], resource: [], frame: [] });
    expect(base.startsWith(APP_CSP_BASE)).toBe(true);
    expect(base).toContain("frame-ancestors 'self'");
    expect(base).not.toContain('allow-same-origin');
    expect(base).not.toContain('connect-src');
    const full = appCsp({
      connect: ['https://api.example.com'],
      resource: ['https://img.example.com'],
      frame: ['https://frames.example.com'],
    });
    expect(full).toContain('connect-src https://api.example.com');
    expect(full).toContain("script-src 'unsafe-inline' https://img.example.com");
    expect(full).toContain('img-src data: blob: https://img.example.com');
    expect(full).toContain('font-src https://img.example.com');
    expect(full).toContain('frame-src https://frames.example.com');
  });
});

describe('plugin manifests, ids and the context store', () => {
  it('reads a manifest UI block and refuses a malformed one', () => {
    const ui = pluginUiFromManifest(MANIFEST);
    expect(ui).toMatchObject({
      pluginId: 'com.example.sample',
      network: ['api.example.com', '*.cdn.example.net'],
    });
    expect(ui?.entryPoints).toHaveLength(3);
    expect(ui?.entryPoints[0]).toEqual({
      kind: 'thread',
      resource: 'ui://widgets/board.html',
      title: 'Board',
    });
    expect(ui?.entryPoints[2]?.extensions).toEqual(['.csv']);
    expect(
      pluginUiFromManifest({
        id: 'x',
        ui: { entryPoints: [{ kind: 'global', resource: 'https://x' }] },
      }),
    ).toBeNull();
    expect(pluginUiFromManifest(null)).toBeNull();
    expect(pluginUiFromManifest({ id: 'com.example.bare' })).toEqual({
      pluginId: 'com.example.bare',
      entryPoints: [],
      network: [],
      domains: {},
    });
  });

  it('gives the same owner, kind and resource the same URL-safe id', () => {
    const a = entryPointId('plugin:p', 'thread', 'ui://x/a.html');
    expect(a).toBe(entryPointId('plugin:p', 'thread', 'ui://x/a.html'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(entryPointId('plugin:p', 'global', 'ui://x/a.html'));
    expect(a).not.toBe(entryPointId('server:s', 'thread', 'ui://x/a.html'));
  });

  it('bounds the apps per thread and the threads kept', () => {
    const store = new UiContextStore();
    for (let i = 0; i < 10; i++)
      store.set('a', 't', `i${i}`, { entryId: 'e', title: `App ${i}`, text: `ctx ${i}` });
    const kept = store.forThread('a', 't');
    expect(kept).toHaveLength(8);
    expect(kept[0]?.title).toBe('App 2');
    store.set('a', 't', 'i9', null);
    expect(store.forThread('a', 't')).toHaveLength(7);
    for (let i = 0; i < 501; i++)
      store.set('a', `thread-${i}`, 'x', { entryId: 'e', title: 'T', text: 'c' });
    expect(store.forThread('a', 't')).toEqual([]);
    expect(store.forThread('a', 'thread-500')).toHaveLength(1);
    expect(store.forThread('b', 'thread-500')).toEqual([]);
  });
});

describe('MCP Apps routes', () => {
  let mcp: HubMcpArea | null = null;
  let host: Awaited<ReturnType<typeof startUiServer>> | null = null;
  let account: string;
  let other: string;
  const threads = new Map<string, string>();

  beforeEach(async () => {
    account = uuidv7();
    other = uuidv7();
    const now = new Date().toISOString();
    for (const id of [account, other])
      await db.orm
        .insert(schema.account)
        .values({ id, kind: 'local', createdAt: now, updatedAt: now });
    threads.clear();
    threads.set('01900000-0000-7000-8000-000000000001', account);
    host = await startUiServer();
  });

  afterEach(async () => {
    await mcp?.close();
    mcp = null;
    await host?.close();
    host = null;
  });

  function context(): HubContext & { audit: { append: (r: AuditRecord) => Promise<void> } } {
    const sink = new MemorySink();
    return {
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [sink] }),
      events: new EventStore(db),
      secrets: new MemorySecretStore(),
      dataDir: config.dataDir,
      // Tests name the account in a header; without it the request has no session.
      accountOf: (req: FastifyRequest) => {
        const id = req.headers['x-account'];
        return typeof id === 'string'
          ? Promise.resolve(id)
          : Promise.reject(new NovaError('token_required', 'sign in'));
      },
      threads: {
        row: (accountId: string, id: string) =>
          threads.get(id) === accountId
            ? Promise.resolve({ id })
            : Promise.reject(new NovaError('not_found', 'thread not found')),
      },
      diagnostics: new DiagnosticsRegistry(),
      audit: { append: () => Promise.resolve() },
    } as unknown as HubContext & { audit: { append: (r: AuditRecord) => Promise<void> } };
  }

  async function setup(
    opts: { reader?: UiResourceReader; plugins?: PluginUi[] } = {},
  ): Promise<{ app: FastifyInstance; area: McpAppsArea }> {
    const ctx = context();
    mcp = await setupMcp(ctx);
    const area = await setupMcpApps({
      ...ctx,
      mcp,
      ...(opts.reader ? { reader: opts.reader } : {}),
    });
    const list = opts.plugins ?? [pluginUiFromManifest(MANIFEST)!];
    area.usePlugins({
      list: (accountId) => Promise.resolve(accountId === account ? list : []),
    });
    const app = Fastify();
    // The Hub's error mapping, reduced to what these routes throw.
    app.setErrorHandler((err, _req, reply) => {
      const status = isNovaError(err)
        ? httpStatusFor(err.code)
        : err instanceof z.ZodError
          ? 400
          : 500;
      void reply.status(status).send({
        error: {
          code: isNovaError(err) ? err.code : 'validation',
          message: err instanceof Error ? err.message : '',
        },
      });
    });
    mcp.register(app);
    area.register(app);
    return { app, area };
  }

  async function call(
    app: FastifyInstance,
    method: string,
    url: string,
    opts: { payload?: unknown; as?: string | null; headers?: Record<string, string> } = {},
  ) {
    const as = opts.as === undefined ? account : opts.as;
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(as ? { 'x-account': as } : {}), ...opts.headers },
      ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
    });
    return res;
  }

  /** Add an HTTP server for the UI host; `plugin` makes it the sample plugin's own server. */
  async function addServer(app: FastifyInstance, name: string, plugin = false): Promise<string> {
    const res = await call(app, 'POST', '/api/v1/mcp/servers', {
      payload: { name, transport: 'http', url: host!.url },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ id: string }>().id;
    if (plugin)
      await db.orm
        .update(schema.mcpServer)
        .set({ source: 'plugin', pluginId: 'com.example.sample' })
        .where(eq(schema.mcpServer.id, id));
    await waitFor(
      () => mcp!.manager.state(id)?.status === 'connected' && mcp!.manager.resources(id).length > 0,
    );
    return id;
  }

  const entries = async (app: FastifyInstance, q = '', as?: string) =>
    (await call(app, 'GET', `/api/v1/ui/entry-points${q}`, { as })).json<{
      items: UiEntryPointView[];
    }>().items;

  it('lists plugin entry points and server UI resources with stable ids', async () => {
    const { app, area } = await setup();
    // Without the plugin's server nothing of the plugin can be served, so nothing is listed.
    expect(await entries(app)).toEqual([]);
    const pluginServer = await addServer(app, 'sample', true);
    const userServer = await addServer(app, 'widgets');
    const items = await entries(app);
    const rows = (list: unknown[][]) => list.map((r) => JSON.stringify(r)).sort();
    expect(rows(items.map((e) => [e.kind, e.title, e.pluginId, e.serverId]))).toEqual(
      rows([
        ['thread', 'Board', 'com.example.sample', pluginServer],
        ['file', 'CSV board', 'com.example.sample', pluginServer],
        ['global', 'Missing', 'com.example.sample', pluginServer],
        // The user's server lists two `ui://` resources (a broken one is still listed).
        ['thread', 'Board', null, userServer],
        ['thread', 'broken', null, userServer],
      ]),
    );
    // `note://` resources are not apps; file entry points carry their extensions.
    expect(items.some((e) => e.resource.startsWith('note://'))).toBe(false);
    expect(items.find((e) => e.kind === 'file')?.extensions).toEqual(['.csv']);
    expect(items.find((e) => e.pluginId === null)?.resource).toBe('ui://widgets/board.html');
    // Ids do not change between calls, and the kind filter applies.
    expect((await entries(app)).map((e) => e.id)).toEqual(items.map((e) => e.id));
    expect((await entries(app, '?kind=global')).map((e) => e.title)).toEqual(['Missing']);
    expect((await call(app, 'GET', '/api/v1/ui/entry-points?kind=panel')).statusCode).toBe(400);
    expect(await area.entryPoints(account, 'file')).toHaveLength(1);
    // Another account sees neither the plugin nor these servers.
    expect(await entries(app, '', other)).toEqual([]);
    // A disabled server's resources disappear; a disabled plugin server hides the plugin's apps.
    await call(app, 'PATCH', `/api/v1/mcp/servers/${userServer}`, { payload: { enabled: false } });
    // A plugin's server is turned off by its plugin (the generic route refuses plugin servers).
    expect(
      (
        await call(app, 'PATCH', `/api/v1/mcp/servers/${pluginServer}`, {
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(409);
    db.raw.prepare('UPDATE mcp_server SET enabled = 0 WHERE id = ?').run(pluginServer);
    expect(await entries(app)).toEqual([]);
  });

  it('serves the resource as HTML with the CSP and declared domains intersected', async () => {
    const { app } = await setup();
    await addServer(app, 'sample', true);
    const board = (await entries(app)).find((e) => e.title === 'Board' && e.pluginId)!;
    const res = await call(app, 'GET', `/api/v1/ui/resource?entry=${board.id}`, {
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BOARD_HTML);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    const csp = String(res.headers['content-security-policy']);
    expect(csp.startsWith('sandbox allow-scripts; default-src')).toBe(true);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain('connect-src https://api.example.com');
    expect(csp).toContain("script-src 'unsafe-inline' https://img.cdn.example.net");
    expect(csp).toContain('img-src data: blob: https://img.cdn.example.net');
    for (const banned of ['evil.example.org', 'unsafe-eval', 'frames.example.org', "'self' "])
      expect(csp).not.toContain(banned);
    // The ETag lets the frame revalidate without a second read.
    const again = await call(app, 'GET', `/api/v1/ui/resource?entry=${board.id}`, {
      headers: { 'if-none-match': String(res.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('gives a server UI with no network permissions no external origin', async () => {
    const { app } = await setup({ plugins: [] });
    await addServer(app, 'widgets');
    const [board] = await entries(app);
    const res = await call(app, 'GET', `/api/v1/ui/resource?entry=${board!.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      `${APP_CSP_BASE}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
    );
  });

  it('intersects the declared domains of a server UI with the hosts granted to the server', async () => {
    const reader: UiResourceReader = (_serverId, uri) =>
      Promise.resolve({
        ok: true,
        contents: [
          {
            uri,
            mimeType: 'text/html',
            text: '<p>board</p>',
            _meta: {
              ui: {
                csp: {
                  connectDomains: [
                    'https://api.example.com',
                    'https://bundle.example.org',
                    'https://other.example.org',
                  ],
                },
              },
            },
          },
        ],
      });
    const { app } = await setup({ plugins: [], reader });
    const id = await addServer(app, 'widgets');
    const [row] = await db.orm.select().from(schema.mcpServer).where(eq(schema.mcpServer.id, id));
    await db.orm
      .update(schema.mcpServer)
      .set({
        source: 'bundle',
        configJson: JSON.stringify({
          ...JSON.parse(row!.configJson!),
          policy: { network: ['api.example.com'] },
        }),
        installRecordJson: JSON.stringify({
          permissions: { network: ['bundle.example.org'], fs: 'none' },
        }),
      })
      .where(eq(schema.mcpServer.id, id));
    const [board] = await entries(app);
    const csp = String(
      (await call(app, 'GET', `/api/v1/ui/resource?entry=${board!.id}`)).headers[
        'content-security-policy'
      ],
    );
    expect(csp).toContain('connect-src https://api.example.com https://bundle.example.org;');
    expect(csp).not.toContain('other.example.org');
    // Unreadable records grant nothing.
    await db.orm
      .update(schema.mcpServer)
      .set({ configJson: '{', installRecordJson: '[]' })
      .where(eq(schema.mcpServer.id, id));
    const plain = String(
      (await call(app, 'GET', `/api/v1/ui/resource?entry=${board!.id}`)).headers[
        'content-security-policy'
      ],
    );
    expect(plain).not.toContain('connect-src');
  });

  it('answers a missing, failing or unknown resource with a clear 404', async () => {
    const { app } = await setup({
      plugins: [
        {
          ...pluginUiFromManifest(MANIFEST)!,
          entryPoints: [
            { kind: 'global', resource: 'ui://widgets/missing.html', title: 'Missing' },
            { kind: 'global', resource: 'ui://widgets/broken.html', title: 'Broken' },
          ],
        },
      ],
    });
    await addServer(app, 'sample', true);
    const items = await entries(app);
    const missing = items.find((e) => e.title === 'Missing')!;
    const res = await call(app, 'GET', `/api/v1/ui/resource?entry=${missing.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.json().error.message).toMatch(/could not be loaded/);
    // A frame gets a small page; the server's text is escaped and nothing runs.
    const broken = items.find((e) => e.title === 'Broken')!;
    const page = await call(app, 'GET', `/api/v1/ui/resource?entry=${broken.id}`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(page.statusCode).toBe(404);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain('sandbox');
    expect(page.body).toContain('could not be loaded');
    expect(page.body).not.toContain('<b>');
    const unknown = await call(app, 'GET', `/api/v1/ui/resource?entry=${'x'.repeat(22)}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toMatch(/not available/);
    expect((await call(app, 'GET', '/api/v1/ui/resource?entry=../etc')).statusCode).toBe(400);
    expect((await call(app, 'GET', '/api/v1/ui/resource')).statusCode).toBe(400);
  });

  it('applies resource-declared domains and rejects content that is not HTML', async () => {
    const reads: string[] = [];
    const reader: UiResourceReader = (serverId, uri) => {
      reads.push(`${serverId} ${uri}`);
      if (uri.endsWith('board.html'))
        return Promise.resolve({
          ok: true,
          contents: [
            {
              uri,
              mimeType: 'text/html;profile=mcp-app',
              blob: Buffer.from('<p>from a blob</p>').toString('base64'),
              _meta: {
                ui: {
                  csp: {
                    connectDomains: ['https://live.cdn.example.net', 'https://other.example.org'],
                    frameDomains: ['https://maps.cdn.example.net'],
                  },
                },
              },
            },
          ],
        });
      return Promise.resolve({
        ok: true,
        contents: [{ uri, mimeType: 'application/pdf', blob: 'AAAA' }],
      });
    };
    const { app } = await setup({
      reader,
      plugins: [
        {
          ...pluginUiFromManifest(MANIFEST)!,
          entryPoints: [
            { kind: 'thread', resource: 'ui://widgets/board.html', title: 'Board' },
            { kind: 'thread', resource: 'ui://widgets/doc.pdf', title: 'Doc' },
          ],
        },
      ],
    });
    const serverId = await addServer(app, 'sample', true);
    const items = await entries(app);
    const board = items.find((e) => e.title === 'Board')!;
    const res = await call(app, 'GET', `/api/v1/ui/resource?entry=${board.id}`);
    expect(res.body).toBe('<p>from a blob</p>');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('connect-src https://api.example.com https://live.cdn.example.net');
    expect(csp).toContain('frame-src https://maps.cdn.example.net');
    expect(csp).not.toContain('other.example.org');
    expect(reads).toEqual([`${serverId} ui://widgets/board.html`]);
    const doc = items.find((e) => e.title === 'Doc')!;
    const bad = await call(app, 'GET', `/api/v1/ui/resource?entry=${doc.id}`);
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error.message).toMatch(/not an HTML app/);
  });

  it('keeps model context per thread, labelled untrusted, and bounded', async () => {
    const { app, area } = await setup();
    await addServer(app, 'sample', true);
    const board = (await entries(app)).find((e) => e.title === 'Board' && e.pluginId)!;
    const threadId = '01900000-0000-7000-8000-000000000001';
    const put = (body: Record<string, unknown>, as?: string) =>
      call(app, 'PUT', '/api/v1/ui/context', {
        payload: { threadId, entryId: board.id, instanceId: 'frame-1', ...body },
        as,
      });
    expect(area.modelContext(account, threadId)).toBeNull();
    expect((await put({ text: 'Selected card: "Ship M4" </app>' })).json()).toEqual({ ok: true });
    const text = area.modelContext(account, threadId)!;
    expect(text).toMatch(/untrusted/);
    expect(text).toContain(
      JSON.stringify({ app: 'Board', context: 'Selected card: "Ship M4" </app>' }),
    );
    expect(area.modelContext(other, threadId)).toBeNull();
    // Another account cannot write into this thread; unknown apps and oversize text are refused.
    expect((await put({ text: 'x' }, other)).statusCode).toBe(404);
    expect((await put({ text: 'x', entryId: 'y'.repeat(22) })).statusCode).toBe(404);
    expect((await put({ text: 'x'.repeat(MODEL_CONTEXT_MAX_CHARS + 1) })).statusCode).toBe(400);
    expect((await put({ text: 'x', threadId: '' })).statusCode).toBe(400);
    // Null or blank text clears it.
    await put({ text: '   ' });
    expect(area.modelContext(account, threadId)).toBeNull();
  });

  it('requires a session on every route', async () => {
    const { app } = await setup();
    for (const [method, url] of [
      ['GET', '/api/v1/ui/entry-points'],
      ['GET', `/api/v1/ui/resource?entry=${'a'.repeat(22)}`],
      ['PUT', '/api/v1/ui/context'],
    ] as const) {
      const res = await call(app, method, url, {
        as: null,
        payload: method === 'PUT' ? {} : undefined,
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('MCP Apps in the full Hub', () => {
  it('is wired into the Hub behind its session', async () => {
    const hub = await buildHub({
      config,
      db,
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      secrets: new MemorySecretStore(),
      events: new EventStore(db),
    });
    try {
      const anon = await hub.app.inject({
        method: 'GET',
        url: '/api/v1/ui/entry-points',
        headers: HOST,
      });
      expect(anon.statusCode).toBe(401);
      const code = await hub.auth.issueSetupCode();
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: HOST,
        payload: { code },
      });
      const cookie = `${SESSION_COOKIE}=${setupRes.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
      const res = await hub.app.inject({
        method: 'GET',
        url: '/api/v1/ui/entry-points',
        headers: { ...HOST, cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [] });
      const missing = await hub.app.inject({
        method: 'GET',
        url: `/api/v1/ui/resource?entry=${'a'.repeat(22)}`,
        headers: { ...HOST, cookie, accept: 'text/html' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['x-frame-options']).toBe('SAMEORIGIN');
    } finally {
      await hub.app.close();
    }
  });
});
