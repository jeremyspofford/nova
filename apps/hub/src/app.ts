// Hub HTTP/WS application (contracts/hub-api.md). `buildHub` wires routes onto a Fastify
// instance; `main.ts` owns process concerns (config, signals, ports).
import { existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  NovaError,
  checkSettingWrite,
  httpStatusFor,
  isNovaError,
  resolveAll,
  resolveSetting,
  uuidv7,
  type SettingKey,
  type SettingLayers,
} from '@nova/shared';
import {
  ChatService,
  MemoryService,
  NodeModelSource,
  NodeService,
  ProjectService,
  ProviderRegistry,
  Router,
  SourceService,
  ThreadService,
  detectLocalServers,
  type ChatServiceOptions,
  type ModelRouter,
  type ProviderFactory,
  type ToolRuntimeOptions,
} from '@nova/core';
import { MemorySecretStore, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import { AuthService, type Principal } from './auth.ts';
import { openStream, registerChatRoutes } from './chat-routes.ts';
import type { HubConfig } from './config.ts';
import { EventStore } from './event-store.ts';
import { registerMemoryRoutes } from './memory-routes.ts';
import { registerModelRoutes } from './model-routes.ts';
import { setupConsolidation } from './consolidation.ts';
import { setupHooks } from './hooks.ts';
import { pluginUiFromManifest, setupMcpApps } from './mcp-apps.ts';
import { setupMcpServer } from './mcp-server.ts';
import { setupPlugins } from './plugins.ts';
import { setupProfile } from './profile.ts';
import { setupWorkspace } from './workspace.ts';
import { setupCode } from './code.ts';
import { setupRequests } from './requests.ts';
import { setupRuns } from './runs.ts';
import { setupSchedules } from './schedules.ts';
import { DiagnosticsRegistry, type HubContext } from './hub-context.ts';
import { setupMcp } from './mcp.ts';
import { registerNodeRoutes } from './node-routes.ts';
import { setupOps } from './ops.ts';
import { setupPolicy } from './policy.ts';
import { setupTools } from './tools.ts';
import { registerProjectRoutes } from './project-routes.ts';

export const SESSION_COOKIE = 'nova_session';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface HubDeps {
  config: HubConfig;
  db: NovaDatabase;
  log: Logger;
  auth?: AuthService;
  events?: EventStore;
  /** Managed-policy settings layer (docs/12 §10); empty until M8. */
  managedSettings?: () => Record<string, unknown>;
  /** Credential store (FR-101). Defaults to an in-memory store; `main.ts` passes the vault. */
  secrets?: SecretStore;
  /** Where blobs live (docs/06 §3); defaults to `config.dataDir`. */
  dataDir?: string;
  /** Override provider construction (tests use scripted mock providers). */
  providerFactory?: ProviderFactory;
  chat?: Pick<
    ChatServiceOptions,
    'flushIntervalMs' | 'deltaIntervalMs' | 'systemPrompt' | 'memoryTimeoutMs'
  >;
  /** How often temporary chats past their TTL are purged (default 10 min, FR-027). */
  sweepIntervalMs?: number;
  /** Replace the model router (tests); the default is the full Router (docs/07 §8-§9). */
  router?: (registry: ProviderRegistry) => ModelRouter;
  /** Probe for local model servers (tests replace it; docs/07 §12). */
  detect?: typeof detectLocalServers;
}

export interface Hub {
  app: FastifyInstance;
  auth: AuthService;
  events: EventStore;
  registry: ProviderRegistry;
  router: ModelRouter;
  nodes: NodeService;
  threads: ThreadService;
  chat: ChatService;
  projects: ProjectService;
  sources: SourceService;
  memory: MemoryService;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export async function buildHub(deps: HubDeps): Promise<Hub> {
  const { config, db, log } = deps;
  async function loadLayers(projectId?: string): Promise<SettingLayers> {
    const rows = await db.orm.select().from(schema.setting);
    const global: Record<string, unknown> = {};
    const project: Record<string, unknown> = {};
    for (const r of rows) {
      if (r.scopeKind === 'global') global[r.key] = JSON.parse(r.valueJson) as unknown;
      if (r.scopeKind === 'project' && r.scopeRef === projectId)
        project[r.key] = JSON.parse(r.valueJson) as unknown;
    }
    return { global, project, managed: deps.managedSettings?.() ?? {} };
  }
  const auth = deps.auth ?? new AuthService(db);
  const events = deps.events ?? new EventStore(db);
  const dataDir = deps.dataDir ?? config.dataDir;
  const secrets = deps.secrets ?? new MemorySecretStore();
  const registry = new ProviderRegistry({
    db,
    secrets,
    log: log.child('providers'),
    ...(deps.providerFactory ? { factory: deps.providerFactory } : {}),
  });
  const setting = async <K extends SettingKey>(key: K, projectId?: string | null) =>
    resolveSetting(key, await loadLayers(projectId ?? undefined)).value;
  // Compute nodes register with the Hub and serve models as a router source (FR-126, FR-127).
  const nodes = new NodeService({ db, secrets, events, log: log.child('nodes') });
  const fullRouter = new Router({
    registry,
    sources: [new NodeModelSource({ nodes })],
    settings: async () => {
      const layers = await loadLayers();
      return {
        presets: resolveSetting('models.presets', layers).value,
        order: resolveSetting('routing.order', layers).value,
        allowCloud: resolveSetting('routing.allowCloud', layers).value,
      };
    },
    log: log.child('router'),
  });
  const router: ModelRouter = deps.router?.(registry) ?? fullRouter;
  const threads = new ThreadService({
    db,
    router,
    events,
    defaultModel: () => setting('chat.defaultModel'),
  });
  const projects = new ProjectService({ db });
  const sources = new SourceService({ db, events, dataDir, log: log.child('sources') });
  const memory = new MemoryService({
    db,
    events,
    log: log.child('memory'),
    enabled: (projectId) => setting('memory.enabled', projectId),
  });
  const accountOf = async (req: FastifyRequest): Promise<string> => {
    const p = requireAuth(req);
    if (p.accountId) return p.accountId;
    // Only sessions authenticate here (auth.ts); one without an account acts for the owner.
    const owner = await auth.ownerAccount();
    if (!owner) throw new NovaError('auth_missing', 'the Hub has no owner account yet');
    return owner.id;
  };

  // ---- M3 areas: ops (audit, notifications, logs), policy and approvals, MCP, tools -------
  const ctx: HubContext = {
    config,
    db,
    log,
    events,
    secrets,
    dataDir,
    registry,
    router,
    nodes,
    threads,
    setting,
    accountOf,
    diagnostics: new DiagnosticsRegistry(),
  };
  const ops = await setupOps(ctx);
  const policy = await setupPolicy({ ...ctx, audit: ops.audit, notifier: ops.notifier });
  const mcp = await setupMcp({ ...ctx, audit: ops.audit });
  // M4: plugins (skills, their MCP servers and permissions) and hooks come before the tools,
  // whose chat loop uses them.
  const plugins = await setupPlugins({ ...ctx, audit: ops.audit, mcp });
  // The user's default approval per MCP server feeds the gate (FR-048). A plugin server's
  // manifest default is the plugin's: the gate reads it with the plugin's permissions.
  policy.useServerDefaults((_accountId, serverId) => Promise.resolve(mcp.serverDefault(serverId)));
  const hooks = await setupHooks({
    ...ctx,
    audit: ops.audit,
    gate: policy.gate,
    managedHooks: () => deps.managedSettings?.()['hooks'],
  });
  // Plugin hooks come from the plugins area, which shows how many wait for trust.
  hooks.usePluginHooks(plugins.hooks);
  plugins.useHookTrust((accountId, pluginId) => hooks.untrustedPluginHooks(accountId, pluginId));
  policy.useHooks(hooks.dispatcher);
  policy.usePluginPermissions(plugins.permissions);
  policy.usePluginViolations((accountId, pluginId) =>
    plugins.service.setEnabled(accountId, pluginId, false),
  );
  // The apps area exists after the tools; the chat loop reads its model context late-bound.
  let mcpApps: Awaited<ReturnType<typeof setupMcpApps>> | null = null;
  const tools = await setupTools({
    ...ctx,
    gate: policy.gate,
    sources: [mcp.source, plugins.skills.tools],
    audit: ops.audit,
    notifier: ops.notifier,
    hooks: hooks.dispatcher,
    skills: plugins.skills,
    pluginPermissions: plugins.permissions,
    appContext: (accountId, threadId) =>
      Promise.resolve(mcpApps ? mcpApps.modelContext(accountId, threadId) : null),
  });
  // The gate previews and classifies with the tools' own descriptors and the sandbox in use.
  policy.useToolCatalog(tools.catalog);
  policy.useSubstrate(() => tools.substrate());
  hooks.useSandbox(tools.sandbox);
  hooks.useMcp(mcp.manager);
  const scope: ToolRuntimeOptions['scope'] = (input) =>
    tools.runtime.scopeFor(input.accountId, input.threadId, input.projectId);
  hooks.useScope(scope);
  const consolidation = await setupConsolidation({ ...ctx, memory });
  const mcpServer = await setupMcpServer({ ...ctx, audit: ops.audit, gate: policy.gate, tools });
  const apps = await setupMcpApps({ ...ctx, mcp });
  mcpApps = apps;
  apps.usePlugins({
    list: async (accountId) =>
      (await plugins.enabledManifests(accountId)).flatMap((p) => {
        const ui = pluginUiFromManifest(p.manifest);
        return ui ? [ui] : [];
      }),
  });
  const workspace = await setupWorkspace({
    ...ctx,
    audit: ops.audit,
    gate: policy.gate,
    sandbox: () => tools.sandbox,
    scope,
  });
  const profile = await setupProfile({
    ...ctx,
    audit: ops.audit,
    mcp,
    plugins,
    folders: workspace.folders,
    memory,
    projects,
  });
  // M5: requests, runs, schedules and Code sessions (wired to the chat loop below).
  const requests = await setupRequests(ctx);
  const runs = await setupRuns(ctx);
  const schedules = await setupSchedules(ctx);
  const code = await setupCode(ctx);
  const areas = [
    code,
    schedules,
    runs,
    requests,
    profile,
    workspace,
    apps,
    mcpServer,
    tools,
    hooks,
    plugins,
    consolidation,
    mcp,
    policy,
    ops,
  ];

  const chat = new ChatService({
    db,
    router,
    threads,
    events,
    dataDir,
    log: log.child('chat'),
    memory,
    sources,
    settings: {
      followUp: (projectId) => setting('general.followUp', projectId),
      temporaryTtlHours: () => setting('chat.temporaryTtlHours'),
    },
    ...tools.chatOptions,
    ...deps.chat,
  });
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    genReqId: () => uuidv7(),
    trustProxy: false,
  });

  // Open event streams are ended before the server closes, and running turns are cancelled and
  // saved before the database goes away (FR-018).
  const streams = new Set<() => void>();
  const trackStream = (end: () => void) => {
    streams.add(end);
    return () => streams.delete(end);
  };
  app.addHook('preClose', (done) => {
    for (const end of [...streams]) end();
    done();
  });
  // Temporary chats past their TTL are purged in the background (FR-027); main.ts also sweeps
  // at startup.
  const sweeper = setInterval(
    () => {
      chat.sweepTemporary().catch((err: unknown) => log.warn('temporary sweep failed', { err }));
    },
    deps.sweepIntervalMs ?? 10 * 60_000,
  );
  sweeper.unref();
  nodes.start();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    nodes.stop();
    await chat.shutdown();
    await sources.stop();
    for (const a of areas) await a.close();
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), usb=()');
    reply.header('Content-Security-Policy', CSP);
    guardHostAndOrigin(req, config);
    req.principal = await authenticate(req, auth);
  });

  app.addHook('onResponse', (req, reply, done) => {
    log.info('request', {
      method: req.method,
      url: req.url.split('?')[0],
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      requestId: req.id,
    });
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err)) {
      void reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
      return;
    }
    if (err instanceof z.ZodError) {
      const body = new NovaError('validation', 'request failed validation', {
        details: {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      void reply.status(400).send({ error: body.toJSON(), requestId: req.id });
      return;
    }
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) log.error('unhandled error', { err, requestId: req.id });
    const code = status === 404 ? 'not_found' : status < 500 ? 'validation' : 'server_error';
    const message = status < 500 && err instanceof Error ? err.message : 'internal error';
    void reply
      .status(status)
      .send({ error: { code, message, retryable: status >= 500 }, requestId: req.id });
  });

  // ---- public ---------------------------------------------------------------------------
  app.get('/api/v1/hello', async () => ({
    name: 'nova-hub',
    version: config.version,
    apiVersions: ['v1'],
    features: [],
    setupRequired: (await auth.ownerAccount()) === null,
  }));

  app.get('/api/v1/health', () => ({ status: 'ok', version: config.version }));

  // ---- auth -----------------------------------------------------------------------------
  const setupBody = z.object({
    code: z.string().min(10).max(200),
    displayName: z.string().max(100).optional(),
  });
  app.post('/api/v1/auth/setup', async (req, reply) => {
    const body = setupBody.parse(req.body);
    const { session, accountId } = await auth.redeemSetupCode(body.code, body.displayName);
    // Local-first: a fresh owner can chat offline at once with the mock provider.
    await registry.ensureDefaultProvider(accountId);
    void reply.setCookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    await events.emit({
      name: 'auth.session.created',
      actor: 'user',
      accountId,
      payload: { accountId },
    });
    return { accountId };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const p = requireAuth(req);
    await auth.revoke(p.tokenId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await events.emit({
      name: 'auth.session.revoked',
      actor: 'user',
      accountId: p.accountId ?? undefined,
      payload: { accountId: p.accountId },
    });
    return { ok: true };
  });

  app.get('/api/v1/session', async (req) => {
    const p = requireAuth(req);
    const owner = await auth.ownerAccount();
    return { accountId: p.accountId, displayName: owner?.displayName ?? null, kind: p.kind };
  });

  // ---- settings (docs/14 §1) --------------------------------------------------------------

  app.get('/api/v1/settings', async (req) => {
    requireAuth(req);
    const q = z.object({ projectId: z.string().optional() }).parse(req.query);
    return { settings: resolveAll(await loadLayers(q.projectId)) };
  });

  const patchBody = z.object({
    key: z.string().min(1).max(200),
    value: z.unknown(),
    scope: z.enum(['global', 'project']).default('global'),
    projectId: z.string().optional(),
  });
  app.patch('/api/v1/settings', async (req) => {
    const p = requireAuth(req);
    const body = patchBody.parse(req.body);
    await writeSetting(p.accountId, body);
    return { settings: resolveAll(await loadLayers(body.projectId)) };
  });

  /** Validate and store one setting, then announce it (docs/14 §1). */
  async function writeSetting(
    accountId: string | null,
    body: z.infer<typeof patchBody>,
  ): Promise<void> {
    if (body.scope === 'project' && !body.projectId)
      throw new NovaError('validation', 'projectId is required');
    const layers = await loadLayers(body.projectId);
    const check = checkSettingWrite(body.key, body.value, body.scope, layers);
    if (!check.ok) {
      throw new NovaError(
        check.error === 'managed' ? 'policy_denied' : 'validation',
        check.message,
        {
          details: { reason: check.error },
        },
      );
    }
    const scopeRef = body.scope === 'project' ? body.projectId! : '';
    const now = new Date().toISOString();
    await db.transaction(async () => {
      await db.orm
        .delete(schema.setting)
        .where(
          and(
            eq(schema.setting.key, body.key),
            eq(schema.setting.scopeKind, body.scope),
            eq(schema.setting.scopeRef, scopeRef),
          ),
        );
      await db.orm.insert(schema.setting).values({
        key: body.key,
        scopeKind: body.scope,
        scopeRef,
        valueJson: JSON.stringify(check.value),
        updatedAt: now,
      });
    });
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: accountId ?? undefined,
      payload: { key: body.key, scope: body.scope },
    });
  }

  // ---- events (contracts/events.md, hub-api §5) -----------------------------------------
  app.get('/api/v1/events', async (req) => {
    requireAuth(req);
    const q = z
      .object({
        after: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return { events: await events.since(q.after ?? null, q.limit) };
  });

  app.get('/api/v1/events/stream', async (req, reply) => {
    requireAuth(req);
    const lastId =
      (req.headers['last-event-id'] as string | undefined) ??
      (req.query as { after?: string }).after ??
      null;
    return openStream(
      req,
      reply,
      { events, trackStream },
      () => true,
      // Like the thread stream: replay only after a cursor; without one, live events only
      // (contracts/hub-api.md §5), so a fresh client never receives old history.
      async (send) => {
        if (!lastId) return;
        let cursor: string = lastId;
        for (;;) {
          const page = await events.since(cursor, 500);
          for (const e of page) send(e);
          if (page.length < 500) break;
          cursor = page.at(-1)!.id;
        }
      },
    );
  });

  // ---- chat, projects, memory (M1, M2) ------------------------------------------------------
  registerChatRoutes(app, {
    db,
    dataDir,
    events,
    registry,
    router,
    threads,
    chat,
    accountOf,
    trackStream,
  });
  registerProjectRoutes(app, { projects, sources, accountOf });
  registerMemoryRoutes(app, { memory, accountOf });
  registerModelRoutes(app, {
    router: fullRouter,
    readPresets: async () => resolveSetting('models.presets', await loadLayers()).value,
    writePresets: (accountId, items) =>
      writeSetting(accountId, { key: 'models.presets', value: items, scope: 'global' }),
    detect: () => (deps.detect ?? detectLocalServers)(),
    accountOf,
  });
  registerNodeRoutes(app, { nodes, accountOf });
  for (const a of areas) a.register(app);

  void app.register((scoped, _opts, done) => {
    // The session is checked before the upgrade (FR-192): without one the handshake gets 401.
    const sessionFirst = (req: FastifyRequest): Promise<void> => {
      requireAuth(req);
      return Promise.resolve();
    };
    scoped.get('/api/v1/ws', { websocket: true, preValidation: sessionFirst }, (socket, req) => {
      if (!req.principal) {
        socket.close(4401, 'token_required');
        return;
      }
      socket.send(JSON.stringify({ type: 'hello', version: config.version }));
      const off = events.bus.subscribe('*', (e) =>
        socket.send(JSON.stringify({ type: 'event', event: e })),
      );
      socket.on('message', (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          socket.send(
            JSON.stringify({
              type: 'error',
              error: { code: 'validation', message: 'invalid JSON' },
            }),
          );
          return;
        }
        if ((msg as { type?: string }).type === 'ping')
          socket.send(JSON.stringify({ type: 'pong' }));
      });
      socket.on('close', off);
    });
    done();
  });

  // ---- web UI -----------------------------------------------------------------------------
  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      index: ['index.html'],
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api/') &&
        req.headers.accept?.includes('text/html')
      ) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({
        error: { code: 'not_found', message: 'not found', retryable: false },
        requestId: req.id,
      });
    });
  } else {
    log.warn('web UI not built; serving the API only', { webDir: config.webDir });
  }

  return {
    app,
    auth,
    events,
    registry,
    router,
    nodes,
    threads,
    chat,
    projects,
    sources,
    memory,
  };
}

async function authenticate(req: FastifyRequest, auth: AuthService): Promise<Principal | null> {
  const header = req.headers.authorization;
  let token: string | undefined;
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim();
  else token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return auth.verify(token);
}

export function requireAuth(req: FastifyRequest): Principal {
  if (!req.principal)
    throw new NovaError('token_required', 'sign in to use the Hub', {
      action: 'Open the setup link',
    });
  return req.principal;
}

/**
 * Loopback is not an authorization boundary (FR-192), but Host and Origin checks stop DNS
 * rebinding and cross-site requests from a browser. Requests without Origin (CLI, devices) must
 * still present a token.
 */
function guardHostAndOrigin(req: FastifyRequest, config: HubConfig): void {
  const host = (req.headers.host ?? '').toLowerCase();
  const allowedHosts = allowedHostSet(config);
  if (!allowedHosts.has(host) && !allowedHosts.has(host.replace(/:\d+$/, ''))) {
    throw new NovaError('origin_rejected', 'unexpected Host header');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  const allowedOrigins = new Set([`http://${host}`, `https://${host}`, ...config.allowedOrigins]);
  if (!allowedOrigins.has(origin.toLowerCase()))
    throw new NovaError('origin_rejected', 'cross-origin request refused');
}

function allowedHostSet(config: HubConfig): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '[::1]', config.host.toLowerCase()]);
  if (config.host === '0.0.0.0' || config.host === '::') {
    // Listening on every interface: accept this machine's own names and addresses.
    names.add(hostname().toLowerCase());
    names.add(`${hostname().toLowerCase()}.local`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) names.add(a.family === 'IPv6' ? `[${a.address}]` : a.address);
    }
  }
  for (const o of config.allowedOrigins) {
    try {
      names.add(new URL(o).host.toLowerCase());
      names.add(new URL(o).hostname.toLowerCase());
    } catch {
      // ignore malformed entries
    }
  }
  return names;
}

export type { FastifyReply };
