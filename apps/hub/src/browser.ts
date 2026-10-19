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
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  browserActionsQuerySchema,
  browserCaptureQuerySchema,
  browserSiteLevelsQuerySchema,
  browserSitePatternSchema,
  browserSiteScopeParamsSchema,
  patchBrowserSiteSchema,
  putBrowserDomainsSchema,
  putBrowserSiteLevelSchema,
  putBrowserSiteSchema,
  submitBrowserSigninSchema,
  type BrowserSiteScopeKind,
} from '@nova/shared';
import {
  BrowserService,
  ModelReviewer,
  PlaywrightDriver,
  browserToolSource,
  type AgentBrowserController,
  type ArtifactService,
  type AuditSink,
  type BrowserDriver,
  type BrowserScopeResolver,
  type ComputerProvider,
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
  const tools = browserToolSource({ service, threadMode });
  ctx.diagnostics.add('browser', () => service.status());
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
      return service.recorder.page(accountId, q);
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
    useLocalFallback: (fallback) => service.useLocalFallback(fallback),
    useArtifacts: (artifacts) => service.useArtifacts(artifacts),
    useReviewer: (reviewer) => service.useReviewer(reviewer),
    controllerFor: (accountId, computerId) => service.controllerFor(accountId, computerId),
    close: async () => {
      stopSweep();
      offProjectDeleted();
      offAgentDeleted();
      await service.close();
    },
  });
}
