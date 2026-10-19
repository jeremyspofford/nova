// M6 browser area (FR-086, FR-092, FR-094, FR-095, FR-096, FR-098, FR-103, FR-208, FR-209;
// docs/11 §4): the agent browser per computer, its site permissions and domain lists, browser
// sessions, the recorded actions with their screenshots, private sign-in forms and saved logins.
// Every route needs a session and validates its input with zod; credentials sent to the sign-in
// route go to the browser (and the vault when saved), never to a response, a log or the audit.
//
// Wiring (app.ts): the browser and page tools are a tool source (`browser.tools`) for the tools
// area; the policy gate is required (without it every page write and new site is denied);
// computers (egress proxy, profile folders), agents (the thread's computer, the external-agent
// guard), devices (local fallback) and screen (pause/resume) bind late through `use*`.
// M7: site levels per project or agent (`/browser/sites/:pattern/levels/...`,
// `/browser/site-levels`), the trace newest first with a cursor, and the owner's view of a
// browser's console and network capture (redacted like what the agent reads). Deleting a project
// or an agent removes its levels: the area hears `project.deleted` and `agent.deleted` on the bus.
// M7.5 (FR-209, FR-096; ADR-096 D7, D8): the local browser fallback (its consents and sessions,
// the trace's fallback marks) and the extension bridge (status, per-host grants under the owner's
// `/devices/:id/bridge`, and `POST /agent/v1/bridge/events`, which novad calls with its device
// credential like a heartbeat). The fallback asks through the requests area and reaches devices
// through the devices area: `useRequests`, `useDevices`.
import { hostname as osHostname, networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  bridgeEventSchema,
  bridgeEventsSchema,
  browserActionsQuerySchema,
  browserCaptureQuerySchema,
  browserFallbackConsentsQuerySchema,
  browserFallbackSessionsQuerySchema,
  confirmBridgeGrantSchema,
  createBridgeGrantSchema,
  browserSiteLevelsQuerySchema,
  browserSitePatternSchema,
  browserSiteScopeParamsSchema,
  patchBrowserSiteSchema,
  putBrowserDomainsSchema,
  putBrowserSiteLevelSchema,
  putBrowserSiteSchema,
  submitBrowserSigninSchema,
  type BridgeEvent,
  type BrowserActionMarkedView,
  type BrowserSiteScopeKind,
} from '@nova/shared';
import {
  BrowserService,
  DeviceBrowserDriver,
  ExtensionBridgeService,
  LocalFallbackService,
  ModelReviewer,
  PlaywrightDriver,
  bridgeToolSource,
  browserToolSource,
  closeOrphanDeviceSessions,
  connectedComputerResolver,
  hubMdnsName,
  deviceBrowserLink,
  isHubOwner,
  novadDeviceForCredential,
  type AgentBrowserController,
  type ArtifactService,
  type AuditSink,
  type BrowserDriver,
  type BrowserScopeResolver,
  type ComputerProvider,
  type DeviceTransport,
  type DriverLaunchOptions,
  type DriverSession,
  type FallbackDeviceSource,
  type ManagedDevice,
  type RequestBroker,
  type ComputerResolver,
  type EgressProxy,
  type ExternalAgentGuard,
  type LocalBrowserFallback,
  type Notifier,
  type Reviewer,
  type ToolGate,
  type ToolListScope,
  type ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** Screenshot retention runs this often (docs/11 §9). */
const SWEEP_EVERY_MS = 6 * 3_600_000;
/** Device browser sessions the Hub does not know are closed this often (and at start). */
const ORPHAN_SWEEP_MS = 15 * 60_000;

function urlHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The Hub's own names and addresses (FR-096 review): its OS and mDNS names, the configured
 * listen host and extra origins, the Direct public and Relay addresses, the public address
 * channels and MCP event servers reach it at (`channels.publicUrl`, which the Hub answers to), and
 * every interface address. No extension bridge grant, "all sites" included, reaches them.
 */
export async function hubOwnHosts(ctx: HubContext): Promise<string[]> {
  const out = new Set<string>(['localhost']);
  const add = (h: string | null | undefined) => {
    const n = h?.trim().toLowerCase().replace(/\.$/, '');
    if (n) out.add(n);
  };
  const name = osHostname();
  add(name);
  add(name.split('.')[0]);
  add(`${hubMdnsName(name)}.local`);
  const mdns = await ctx.setting('network.lan.mdnsName');
  if (mdns) add(mdns.includes('.') ? mdns : `${mdns}.local`);
  add(urlHostname(await ctx.setting('network.directPublic.url')));
  add(urlHostname(await ctx.setting('relay.url')));
  add(urlHostname(await ctx.setting('channels.publicUrl')));
  const config = ctx.config as Partial<HubContext['config']>;
  if (config.host && !['0.0.0.0', '::', '[::]'].includes(config.host)) add(config.host);
  for (const o of config.allowedOrigins ?? []) add(urlHostname(o));
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) add(a.address.split('%')[0]);
  return [...out];
}

export interface BrowserAreaDeps {
  gate?: ToolGate;
  audit?: AuditSink;
  notifier?: Notifier;
  /** Replace the driver (tests); defaults to Playwright. */
  driver?: BrowserDriver;
  /** The browser stays closed without the egress proxy unless this is false (tests only). */
  requireEgress?: boolean;
  /** Defaults to a ModelReviewer on `review.model`, like the policy area's. */
  reviewer?: Reviewer;
  /** Timers for the retention sweep (tests). */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Connect Playwright to a device's DevTools relay (tests); Playwright's connectOverCDP. */
  connectCdp?: (wsUrl: string, opts: DriverLaunchOptions) => Promise<DriverSession>;
}

/**
 * What the browser area needs of the devices area (DeviceService fits it): the connected
 * computer and its browser module (FR-081, FR-209), the management channel to novad (D1 mutual
 * TLS through `managementTransport` and `connectManagementTls` when present), and the hooks that
 * end fallbacks and bridges with the device.
 */
export interface BrowserDevices extends FallbackDeviceSource {
  device(accountId: string, deviceId: string): Promise<ManagedDevice>;
  managementTransport?: DeviceTransport;
  connectManagementTls?(endpoint: URL, deviceId: string): Promise<Duplex>;
  onRevoked?(hook: (accountId: string, deviceId: string) => void | Promise<void>): () => void;
  onConnectionChanged?(
    hook: (
      accountId: string,
      c: { deviceId: string; agentId: string; status: 'active' | 'revoked' },
    ) => Promise<void>,
  ): () => void;
}

export interface BrowserArea extends HubArea {
  service: BrowserService;
  /** The browser and page tools, for the tools area's sources. */
  tools: ToolSourceProvider;
  useGate(gate: ToolGate): void;
  useEgress(egress: EgressProxy): void;
  useComputers(computers: ComputerProvider): void;
  useComputerResolver(fn: ComputerResolver): void;
  /** Which project and agent a thread belongs to (defaults to the thread and agent tables). */
  useScopeResolver(fn: BrowserScopeResolver): void;
  useExternalAgentGuard(guard: ExternalAgentGuard): void;
  useLocalFallback(fallback: LocalBrowserFallback): void;
  /** The local browser fallback (FR-209) and the extension bridge (FR-096). */
  fallback: LocalFallbackService;
  bridge: ExtensionBridgeService;
  /** The requests area's broker: the fallback's offer is a question to the user (FR-188). */
  useRequests(requests: RequestBroker): void;
  /**
   * The devices area, and which agent a computer belongs to: the fallback's connected computer,
   * novad's browser and bridge routes, and the end of fallbacks with their device or connection.
   */
  useDevices(
    devices: BrowserDevices,
    agentOfComputer: (accountId: string, computerId: string) => Promise<string | null>,
  ): void;
  useArtifacts(artifacts: ArtifactService): void;
  useReviewer(reviewer: Reviewer): void;
  /** A computer's browser for other areas (screen takeover, the computers seam). */
  controllerFor(accountId: string, computerId: string): AgentBrowserController;
}

const patternParam = z.object({ pattern: browserSitePatternSchema });
const idParam = z.object({ id: z.string().min(1).max(100) });
const computerParam = z.object({ computerId: z.string().min(1).max(200) });
const shotParams = z.object({
  id: z.string().min(1).max(100),
  which: z.enum(['before', 'after']),
});
const threadQuery = z.object({ threadId: z.string().min(1).max(100).optional() }).strict();
const deviceParam = z.object({ id: z.string().min(1).max(100) });
const grantParams = z.object({
  id: z.string().min(1).max(100),
  grantId: z.string().min(1).max(100),
});
const grantsQuery = z.object({ all: z.enum(['true', 'false']).optional() }).strict();

/** The device credential of a novad call (`Authorization: Bearer nvc_…`), as heartbeats take it. */
function deviceCredential(req: FastifyRequest): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new NovaError('token_required', 'a device credential is required');
  return token;
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const h = setInterval(fn, ms);
  h.unref();
  return () => clearInterval(h);
}

export function setupBrowser(ctx: HubContext, deps: BrowserAreaDeps = {}): Promise<BrowserArea> {
  const log = ctx.log.child('browser');
  const audit = deps.audit;
  const service = new BrowserService({
    db: ctx.db,
    events: ctx.events,
    dataDir: ctx.dataDir,
    setting: ctx.setting,
    secrets: ctx.secrets,
    driver: deps.driver ?? new PlaywrightDriver(),
    gate: deps.gate ?? null,
    requireEgress: deps.requireEgress !== false,
    reviewer:
      deps.reviewer ??
      new ModelReviewer({
        router: ctx.router,
        model: () => ctx.setting('review.model'),
        log: log.child('review'),
      }),
    log,
    ...(audit ? { audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
  });
  const threadMode = (accountId: string, threadId: string) => {
    const row = ctx.db.raw
      .prepare('SELECT mode FROM thread WHERE id = ? AND account_id = ?')
      .get(threadId, accountId) as { mode: string } | undefined;
    const modes: readonly string[] = ['chat', 'work', 'code', 'agent'];
    const mode = row && modes.includes(row.mode) ? (row.mode as ToolListScope['mode']) : null;
    return Promise.resolve(mode);
  };
  const pageTools = browserToolSource({ service, threadMode });
  ctx.diagnostics.add('browser', () => service.status());
  // M7.5: the extension bridge and the local fallback; devices and requests bind late.
  const bridge = new ExtensionBridgeService({
    db: ctx.db,
    events: ctx.events,
    setting: ctx.setting,
    hubHosts: () => hubOwnHosts(ctx),
    log: log.child('bridge'),
    ...(audit ? { audit } : {}),
  });
  const fallback = new LocalFallbackService({
    db: ctx.db,
    events: ctx.events,
    setting: ctx.setting,
    bridge,
    log: log.child('fallback'),
    ...(audit ? { audit } : {}),
  });
  service.useLocalFallback(fallback);
  // Fallback sessions of a previous run ended with it (review M75 #7).
  void fallback
    .recover()
    .then((n) => {
      if (n) log.info('fallback sessions of the previous run ended', { count: n });
    })
    .catch((err: unknown) => log.warn('ending old fallback sessions failed', { err }));
  // Turning the fallback off stops the sessions that run, not only new offers.
  const offFallbackSetting = ctx.events.bus.subscribe('settings.changed', (e) => {
    if ((e.payload as { key?: unknown }).key !== 'browser.localFallback') return;
    void ctx
      .setting('browser.localFallback')
      .then((on) => {
        if (!on) fallback.stopAll('disabled');
      })
      .catch((err: unknown) => log.warn('stopping fallback sessions failed', { err }));
  });
  // `browser.history_search` (FR-096): the thread's agent's connected computer, once wired.
  let deviceForThread: (accountId: string, threadId: string) => Promise<string | null> = () =>
    Promise.resolve(null);
  const historyTools = bridgeToolSource({
    bridge,
    deviceForThread: (accountId, threadId) => deviceForThread(accountId, threadId),
    setting: (key) => ctx.setting(key),
  });
  const tools: ToolSourceProvider = {
    source: 'browser',
    list: async (accountId, scope) => [
      ...(await pageTools.list(accountId, scope)),
      ...(await historyTools.list(accountId, scope)),
    ],
  };
  const offBridge = bridge.onDisconnected((accountId, deviceId) =>
    fallback.bridgeDisconnected(accountId, deviceId),
  );
  const offDevice: (() => void)[] = [];
  /** Device browser sessions this Hub runs (the orphan sweep leaves them alone). */
  const liveDeviceSessions = new Set<string>();
  const playwright = deps.driver instanceof PlaywrightDriver ? deps.driver : new PlaywrightDriver();
  const connectCdp =
    deps.connectCdp ??
    ((wsUrl: string, opts: DriverLaunchOptions) => playwright.connectOverCdp(wsUrl, opts));
  const useDevices: BrowserArea['useDevices'] = (devices, agentOfComputer) => {
    const link = deviceBrowserLink({
      devices,
      secrets: ctx.secrets,
      ...(devices.managementTransport ? { transport: devices.managementTransport } : {}),
      ...(devices.connectManagementTls
        ? {
            connectTls: (url: URL, deviceId: string) =>
              devices.connectManagementTls!(url, deviceId),
          }
        : {}),
    });
    bridge.useCaller(link);
    fallback.useResolver(connectedComputerResolver({ agentOfComputer, devices }));
    deviceForThread = async (accountId, threadId) => {
      const computerId = await service.computerForThread(accountId, threadId, 'agent');
      const agentId = await agentOfComputer(accountId, computerId);
      const conn = agentId ? await devices.activeConnection(accountId, agentId) : null;
      return conn?.capabilities.includes('browser') ? conn.deviceId : null;
    };
    fallback.useDeviceDriver(
      (input) =>
        new DeviceBrowserDriver({
          link,
          accountId: input.accountId,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          grantee: input.agentId
            ? { kind: 'agent', id: input.agentId }
            : { kind: 'thread', id: input.threadId ?? 'none' },
          allowHosts: input.allowHosts,
          connect: connectCdp,
          onClosed: input.onClosed,
          live: liveDeviceSessions,
          log: log.child('device-browser'),
        }),
    );
    for (const off of offDevice.splice(0)) off();
    // Sessions a device still runs that this Hub does not know (a crash, a close that never
    // arrived) are closed now and every 15 minutes (review M75 #7).
    const sweepOrphans = () => {
      const targets = ctx.db.raw
        .prepare(
          `SELECT d.id AS deviceId, d.account_id AS accountId FROM device d
           JOIN device_management m ON m.device_id = d.id WHERE d.status = 'active'`,
        )
        .all() as { deviceId: string; accountId: string }[];
      return closeOrphanDeviceSessions({
        link,
        targets,
        live: liveDeviceSessions,
        onClosed: (t) =>
          void record(
            t.accountId,
            'browser.fallback.orphan_closed',
            t.deviceId,
            { sessionId: t.sessionId },
            'system',
          ),
        log,
      }).catch((err: unknown) => {
        log.warn('the device browser sweep failed', { err });
        return 0;
      });
    };
    void sweepOrphans();
    offDevice.push((deps.setTimer ?? defaultTimer)(() => void sweepOrphans(), ORPHAN_SWEEP_MS));
    const revoked = devices.onRevoked?.(async (accountId, deviceId) => {
      await fallback.forgetDevice(accountId, deviceId);
      await bridge.forgetDevice(accountId, deviceId);
    });
    if (revoked) offDevice.push(revoked);
    const connection = devices.onConnectionChanged?.((accountId, c) => {
      if (c.status === 'revoked') fallback.connectionEnded(accountId, c.agentId, c.deviceId);
      return Promise.resolve();
    });
    if (connection) offDevice.push(connection);
  };
  const record = async (
    accountId: string,
    action: string,
    resource: string | null,
    detail: Record<string, unknown> = {},
    actor: 'user' | 'system' = 'user',
  ) => {
    await audit
      ?.append({ accountId, actor, kind: 'browser', action, resource, detail })
      .catch((err: unknown) => log.warn('browser audit failed', { err }));
  };
  // A deleted project's or agent's site levels go with it (docs/11 §4.4), audited as Nova's.
  const dropScope = (accountId: string, scopeKind: BrowserSiteScopeKind, scopeRef: string) =>
    service.sites
      .removeScope(accountId, scopeKind, scopeRef)
      .then(async (count) => {
        if (count)
          await record(
            accountId,
            'browser.site.level.removed',
            null,
            { scopeKind, scopeRef, count, reason: `${scopeKind}_deleted` },
            'system',
          );
      })
      .catch((err: unknown) => log.warn('removing site levels failed', { err, scopeKind }));
  const offProjectDeleted = ctx.events.bus.subscribe('project.deleted', (e) => {
    const p = e.payload as { projectId?: unknown };
    if (e.accountId && typeof p.projectId === 'string')
      void dropScope(e.accountId, 'project', p.projectId);
  });
  const offAgentDeleted = ctx.events.bus.subscribe('agent.deleted', (e) => {
    const p = e.payload as { agentId?: unknown };
    if (e.accountId && typeof p.agentId === 'string')
      void dropScope(e.accountId, 'agent', p.agentId);
  });
  const sweep = () =>
    void service.sweep().then(
      (n) => {
        if (n) log.info('browser screenshots past retention removed', { count: n });
      },
      (err: unknown) => log.warn('browser screenshot sweep failed', { err }),
    );
  const stopSweep = (deps.setTimer ?? defaultTimer)(sweep, SWEEP_EVERY_MS);

  function register(app: FastifyInstance): void {
    app.get('/api/v1/browser/status', async (req) => {
      await ctx.accountOf(req);
      return service.status();
    });

    // ---- sites and domain lists (FR-094) -------------------------------------------------------
    app.get('/api/v1/browser/sites', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.sites.list(accountId) };
    });
    app.put('/api/v1/browser/sites', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = putBrowserSiteSchema.parse(req.body);
      const before = service.sites.list(accountId).find((s) => s.pattern === body.pattern) ?? null;
      const view = await service.sites.put(accountId, body);
      await record(accountId, 'browser.site.set', view.pattern, {
        access: view.access,
        level: view.level,
      });
      if (view.devProtocol !== (before?.devProtocol ?? false))
        await record(
          accountId,
          view.devProtocol ? 'browser.devprotocol.enabled' : 'browser.devprotocol.disabled',
          view.pattern,
        );
      return view;
    });
    app.patch('/api/v1/browser/sites/:pattern', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { pattern } = patternParam.parse(req.params);
      const body = patchBrowserSiteSchema.parse(req.body);
      const before = service.sites.get(accountId, pattern);
      const view = await service.sites.patch(accountId, pattern, body);
      await record(accountId, 'browser.site.set', view.pattern, {
        access: view.access,
        level: view.level,
      });
      if (view.devProtocol !== before.devProtocol)
        await record(
          accountId,
          view.devProtocol ? 'browser.devprotocol.enabled' : 'browser.devprotocol.disabled',
          view.pattern,
        );
      return view;
    });
    app.delete('/api/v1/browser/sites/:pattern', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { pattern } = patternParam.parse(req.params);
      await service.sites.remove(accountId, pattern);
      await record(accountId, 'browser.site.removed', pattern);
      return { ok: true };
    });
    // ---- levels per project or agent (M7, docs/11 §4.4: the narrower scope wins) ---------------
    app.get('/api/v1/browser/site-levels', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = browserSiteLevelsQuerySchema.parse(req.query);
      return { items: service.sites.scopedLevels(accountId, q) };
    });
    app.put('/api/v1/browser/sites/:pattern/levels/:scopeKind/:scopeRef', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = browserSiteScopeParamsSchema.parse(req.params);
      const { level } = putBrowserSiteLevelSchema.parse(req.body);
      const view = await service.sites.putScoped(accountId, { ...p, level });
      await record(accountId, 'browser.site.level.set', view.pattern, {
        scopeKind: view.scopeKind,
        scopeRef: view.scopeRef,
        level: view.level,
      });
      return view;
    });
    app.delete('/api/v1/browser/sites/:pattern/levels/:scopeKind/:scopeRef', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = browserSiteScopeParamsSchema.parse(req.params);
      await service.sites.removeScoped(accountId, p);
      await record(accountId, 'browser.site.level.removed', p.pattern, {
        scopeKind: p.scopeKind,
        scopeRef: p.scopeRef,
      });
      return { ok: true };
    });
    app.get('/api/v1/browser/domains', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.sites.domains(accountId);
    });
    app.put('/api/v1/browser/domains', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = putBrowserDomainsSchema.parse(req.body);
      const out = await service.sites.setDomains(accountId, body);
      await record(accountId, 'browser.domains.set', null, {
        allow: out.allow.length,
        deny: out.deny.length,
      });
      return out;
    });

    // ---- sessions and the Activity trace (FR-096, FR-098) --------------------------------------
    app.get('/api/v1/browser/sessions', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.sessions(accountId) };
    });
    app.delete('/api/v1/browser/sessions/:computerId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { computerId } = computerParam.parse(req.params);
      if (!(await service.closeSession(accountId, computerId)))
        throw new NovaError('not_found', 'no open browser for that computer');
      return { ok: true };
    });
    // Newest first; `nextCursor` continues the list (M7).
    app.get('/api/v1/browser/actions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = browserActionsQuerySchema.parse(req.query);
      const page = service.recorder.page(accountId, q);
      // M7.5: each row says whether a local-fallback session recorded it (FR-209).
      const marks = fallback.marks(
        accountId,
        page.items.map((a) => a.id),
      );
      const items: BrowserActionMarkedView[] = page.items.map((a) => ({
        ...a,
        localFallback: marks.get(a.id) ?? null,
      }));
      return { ...page, items };
    });
    // What the browser captured (M7): the owner's view, redacted like the agent's.
    app.get('/api/v1/browser/sessions/:computerId/console', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { computerId } = computerParam.parse(req.params);
      const { limit } = browserCaptureQuerySchema.parse(req.query);
      const view = service.consoleOf(accountId, computerId, limit);
      if (!view) throw new NovaError('not_found', 'no open browser for that computer');
      return view;
    });
    app.get('/api/v1/browser/sessions/:computerId/network', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { computerId } = computerParam.parse(req.params);
      const { limit } = browserCaptureQuerySchema.parse(req.query);
      const view = service.networkOf(accountId, computerId, limit);
      if (!view) throw new NovaError('not_found', 'no open browser for that computer');
      return view;
    });
    app.get('/api/v1/browser/actions/:id/screenshots/:which', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id, which } = shotParams.parse(req.params);
      const bytes = service.recorder.screenshot(accountId, id, which);
      reply.header('content-type', 'image/png');
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(bytes);
    });

    // ---- private sign-in (FR-086) --------------------------------------------------------------
    app.get('/api/v1/browser/signins', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = threadQuery.parse(req.query);
      return { items: service.signins.pending(accountId, q.threadId) };
    });
    app.post('/api/v1/browser/signins/:id/submit', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParam.parse(req.params);
      const body = submitBrowserSigninSchema.parse(req.body);
      const out = await service.signins.submit(accountId, id, body);
      // Which kind of answer, never its values.
      await record(accountId, 'browser.signin.submitted', null, {
        signinId: id,
        saved: 'loginId' in body ? 'reused' : body.save === true ? 'saved' : 'not_saved',
        state: out.state,
      });
      return out;
    });
    app.post('/api/v1/browser/signins/:id/cancel', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParam.parse(req.params);
      await service.signins.cancel(accountId, id);
      return { ok: true };
    });
    app.get('/api/v1/browser/logins', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.signins.logins(accountId) };
    });
    app.delete('/api/v1/browser/logins/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParam.parse(req.params);
      const login = service.signins.login(accountId, id);
      await service.signins.deleteLogin(accountId, id);
      await record(accountId, 'browser.login.deleted', login.host, { loginId: id });
      return { ok: true };
    });

    // ---- M7.5 local browser fallback (FR-209) -----------------------------------------------------
    app.get('/api/v1/browser/fallback/consents', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = browserFallbackConsentsQuerySchema.parse(req.query);
      return {
        items: fallback.consents(accountId, {
          ...(q.scopeKind ? { scopeKind: q.scopeKind } : {}),
          ...(q.scopeRef ? { scopeRef: q.scopeRef } : {}),
          ...(q.deviceId ? { deviceId: q.deviceId } : {}),
          all: q.all === 'true',
        }),
      };
    });
    // Revoking stops a fallback session running on the consent (audited by the service).
    app.delete('/api/v1/browser/fallback/consents/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParam.parse(req.params);
      await fallback.revokeConsent(accountId, id, accountId);
      return { ok: true };
    });
    app.get('/api/v1/browser/fallback/sessions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = browserFallbackSessionsQuerySchema.parse(req.query);
      return {
        items: fallback.sessions(accountId, {
          ...(q.computerId ? { computerId: q.computerId } : {}),
          ...(q.limit ? { limit: q.limit } : {}),
        }),
      };
    });

    // ---- M7.5 extension bridge (FR-096): the owner's, under the devices prefix -------------------
    const owner = async (req: FastifyRequest) => {
      const accountId = await ctx.accountOf(req);
      if (!isHubOwner(ctx.db, accountId))
        throw new NovaError('policy_denied', "only the Hub's owner manages the extension bridge", {
          details: { reason: 'owner_only' },
        });
      return accountId;
    };
    app.get('/api/v1/devices/:id/bridge', async (req) => {
      const accountId = await owner(req);
      return bridge.status(accountId, deviceParam.parse(req.params).id);
    });
    app.get('/api/v1/devices/:id/bridge/grants', async (req) => {
      const accountId = await owner(req);
      const { all } = grantsQuery.parse(req.query);
      return { items: bridge.grants(accountId, deviceParam.parse(req.params).id, all === 'true') };
    });
    app.post('/api/v1/devices/:id/bridge/grants', async (req, reply) => {
      const accountId = await owner(req);
      const { id } = deviceParam.parse(req.params);
      const body = createBridgeGrantSchema.parse(req.body);
      const view = await bridge.createGrant(accountId, id, body, accountId);
      void reply.status(201);
      return view;
    });
    app.post('/api/v1/devices/:id/bridge/grants/:grantId/confirm', async (req) => {
      const accountId = await owner(req);
      const { id, grantId } = grantParams.parse(req.params);
      const body = confirmBridgeGrantSchema.parse(req.body);
      const view = await bridge.confirmGrant(
        accountId,
        grantId,
        body.acknowledgeElevatedRisk ? { acknowledgeElevatedRisk: true } : {},
        accountId,
      );
      if (view.deviceId !== id) throw new NovaError('not_found', 'grant not found');
      return view;
    });
    app.delete('/api/v1/devices/:id/bridge/grants/:grantId', async (req) => {
      const accountId = await owner(req);
      const { id, grantId } = grantParams.parse(req.params);
      if (!bridge.grants(accountId, id, true).some((g) => g.id === grantId))
        throw new NovaError('not_found', 'grant not found');
      await bridge.revokeGrant(accountId, grantId, accountId);
      return { ok: true };
    });

    // ---- novad -> Hub (D8): no session; the device credential, checked like a heartbeat's ---------
    app.post('/agent/v1/bridge/events', async (req) => {
      const credential = deviceCredential(req);
      const device = await novadDeviceForCredential(ctx.db, credential);
      const managed =
        device &&
        ctx.db.raw
          .prepare('SELECT 1 AS x FROM device_management WHERE device_id = ?')
          .get(device.id) !== undefined;
      if (!device || !managed)
        throw new NovaError('auth_missing', 'this device credential is not valid', {
          action: 'Enroll the device again',
        });
      const { events } = bridgeEventsSchema.parse(req.body);
      const valid: BridgeEvent[] = [];
      for (const e of events) {
        const r = bridgeEventSchema.safeParse(e);
        if (r.success) valid.push(r.data);
      }
      const refused = events.length - valid.length;
      if (refused)
        await record(
          device.accountId,
          'browser.bridge.events.refused',
          device.id,
          { count: refused },
          'system',
        );
      const out = valid.length
        ? await bridge.applyEvents({ id: device.id, accountId: device.accountId }, valid)
        : { accepted: 0 };
      return { ...out, refused };
    });
  }

  return Promise.resolve({
    service,
    tools,
    register,
    useGate: (gate) => service.useGate(gate),
    useEgress: (egress) => service.useEgress(egress),
    useComputers: (computers) => service.useComputers(computers),
    useComputerResolver: (fn) => service.useComputerResolver(fn),
    useScopeResolver: (fn) => service.useScopeResolver(fn),
    useExternalAgentGuard: (guard) => service.useExternalAgentGuard(guard),
    useLocalFallback: (f) => service.useLocalFallback(f),
    fallback,
    bridge,
    useRequests: (requests) => fallback.useRequests(requests),
    useDevices,
    useArtifacts: (artifacts) => service.useArtifacts(artifacts),
    useReviewer: (reviewer) => service.useReviewer(reviewer),
    controllerFor: (accountId, computerId) => service.controllerFor(accountId, computerId),
    close: async () => {
      stopSweep();
      offProjectDeleted();
      offAgentDeleted();
      offBridge();
      offFallbackSetting();
      for (const off of offDevice.splice(0)) off();
      await service.close();
    },
  });
}
