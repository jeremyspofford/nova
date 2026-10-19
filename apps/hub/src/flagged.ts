// M7 flagged features (docs/17 §M7: behind flags, off by default): scripted tool calls (FR-202)
// and external agent adapters (FR-203). `script.run` joins the tools area's sources and is listed
// only while `scripts.enabled` is on; its nested calls run through the tools area's runtime, so
// each passes the policy gate like a direct call. Code sessions delegate to external coding
// agents over the Agent Client Protocol while `externalAgents.enabled` is on; the agents run in
// the session's sandbox and every permission request and operation goes to the policy engine.
// While a flag is off its routes answer 404, as if absent, except reading and cancelling a
// delegation; turning `externalAgents.enabled` off stops running delegations. Agents are refused
// in sessions whose environment has no sandbox (SSH, WSL, a device). Both settings are security
// settings: only the owner's global settings or managed policy turn them on (docs/14 §1).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  createAgentAdapterSchema,
  createDelegationSchema,
  idSchema,
  scriptRunsQuerySchema,
  updateAgentAdapterSchema,
} from '@nova/shared';
import {
  ExternalAgentService,
  noopAudit,
  runtimeNestedCaller,
  sandboxAgentLauncher,
  scriptRunView,
  scriptRunsPage,
  scriptToolSource,
  type AgentLauncher,
  type AuditSink,
  type SandboxClient,
  type ToolGate,
  type ToolRuntime,
  type ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface FlaggedArea extends HubArea {
  /** `script.run`, for the tools area's sources (listed only while `scripts.enabled` is on). */
  tools: ToolSourceProvider;
  externalAgents: ExternalAgentService;
  /** The tools area's runtime: nested script calls and agents' operations run through it. */
  useRuntime(runtime: ToolRuntime): void;
  /** The policy gate: external agents' permission requests are decided by it. */
  useGate(gate: ToolGate): void;
  /**
   * The sandboxes external agents run in: the tools' sandbox, and the one a session's own
   * environment routes its commands to (`code.sandboxForThread`). An agent is checked against
   * the routed one: SSH, WSL and device environments have no sandbox, so agents are refused there.
   */
  useSandbox(
    sandbox: () => SandboxClient | null,
    forThread?: (accountId: string, threadId: string) => SandboxClient | null,
  ): void;
}

/** Environment kinds whose commands run on another machine with no sandbox (docs/10 §2). */
const UNSANDBOXED_ENVIRONMENTS = new Set(['ssh', 'wsl', 'device']);

export interface FlaggedDeps {
  audit?: AuditSink;
  /** Replace how agents are started (tests); the default runs them in the session's sandbox. */
  launcher?: AgentLauncher;
  /** Watchdog grace beyond a script's CPU budget (tests). */
  scriptGraceMs?: number;
  now?: () => Date;
}

const idParams = z.object({ id: idSchema });
const checkBody = z.object({ sessionId: idSchema }).strict();

export function setupFlagged(ctx: HubContext, deps: FlaggedDeps = {}): Promise<FlaggedArea> {
  const audit = deps.audit ?? noopAudit;
  let runtime: ToolRuntime | null = null;
  let gate: ToolGate | null = null;
  let sandbox: () => SandboxClient | null = () => null;
  let forThread: ((accountId: string, threadId: string) => SandboxClient | null) | null = null;
  /**
   * The sandbox a session's commands run in. Without the routing wired, a session whose
   * environment runs on another machine gets none (fail closed) rather than the Hub's.
   */
  const pick = (accountId: string, threadId: string): SandboxClient | null => {
    if (forThread) return forThread(accountId, threadId) ?? sandbox();
    const env = ctx.db.raw
      .prepare(
        `SELECT e.kind AS kind FROM code_session cs JOIN environment e ON e.id = cs.environment_id
         WHERE cs.thread_id = ? AND cs.account_id = ?`,
      )
      .get(threadId, accountId) as { kind: string } | undefined;
    return env && UNSANDBOXED_ENVIRONMENTS.has(env.kind) ? null : sandbox();
  };

  const scriptsOn = () => ctx.setting('scripts.enabled');
  const tools = scriptToolSource({
    enabled: scriptsOn,
    limits: async () => {
      const l = await ctx.setting('scripts.limits');
      return {
        cpuMs: l.cpuMs,
        memoryBytes: l.memoryMb * 1024 * 1024,
        maxCalls: l.maxCalls,
        logChars: l.logChars,
      };
    },
    caller: runtimeNestedCaller({ runtime: () => runtime, db: ctx.db }),
    db: ctx.db,
    audit,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.scriptGraceMs !== undefined ? { graceMs: deps.scriptGraceMs } : {}),
  });

  const externalAgents = new ExternalAgentService({
    db: ctx.db,
    events: ctx.events,
    audit,
    secrets: ctx.secrets,
    enabled: () => ctx.setting('externalAgents.enabled'),
    launcher: deps.launcher ?? sandboxAgentLauncher(pick),
    runtime: () => runtime,
    gate: () => gate,
    log: ctx.log.child('acp'),
    clientInfo: { name: 'nova', version: ctx.config.version },
    ...(deps.now ? { now: deps.now } : {}),
  });

  // Turning external agents off stops the delegations that are running, not only new ones.
  const offSetting = ctx.events.bus.subscribe('settings.changed', (e) => {
    if ((e.payload as { key?: unknown }).key !== 'externalAgents.enabled') return;
    void ctx
      .setting('externalAgents.enabled')
      .then(async (on) => {
        if (!on) await externalAgents.stopAll();
      })
      .catch((err: unknown) => ctx.log.warn('delegations not stopped', { err }));
  });

  ctx.diagnostics.add('flagged', async () => {
    const adapters = ctx.db.raw
      .prepare('SELECT count(*) AS n FROM agent_adapter WHERE deleted_at IS NULL')
      .get() as { n: number };
    return {
      scripts: await scriptsOn(),
      externalAgents: await ctx.setting('externalAgents.enabled'),
      delegationsRunning: externalAgents.running,
      adapters: adapters.n,
    };
  });

  /** A Code session's thread, from the session id the Code routes use. */
  const sessionThread = (accountId: string, sessionId: string): string => {
    const row = ctx.db.raw
      .prepare('SELECT thread_id AS threadId FROM code_session WHERE id = ? AND account_id = ?')
      .get(sessionId, accountId) as { threadId: string } | undefined;
    if (!row) throw new NovaError('not_found', 'no such Code session');
    return row.threadId;
  };
  const requireScripts = async () => {
    if (!(await scriptsOn()))
      throw new NovaError('not_found', 'scripted tool calls are turned off');
  };

  function register(app: FastifyInstance): void {
    // ---- scripted tool calls (FR-202) -----------------------------------------------------------
    // One thread's runs, or the account's across threads (M7), newest first and paged.
    app.get('/api/v1/scripts/runs', async (req) => {
      const accountId = await ctx.accountOf(req);
      await requireScripts();
      const q = scriptRunsQuerySchema.parse(req.query);
      if (q.threadId) await ctx.threads.row(accountId, q.threadId);
      return scriptRunsPage(ctx.db, accountId, q);
    });

    app.get('/api/v1/scripts/runs/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await requireScripts();
      return scriptRunView(ctx.db, accountId, idParams.parse(req.params).id);
    });

    // ---- external agent adapters (FR-203) -------------------------------------------------------
    app.get('/api/v1/agent-adapters', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await externalAgents.listAdapters(accountId) };
    });

    app.post('/api/v1/agent-adapters', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      // The flag first: while it is off the route does not exist, whatever the body.
      await externalAgents.listAdapters(accountId);
      const view = await externalAgents.createAdapter(
        accountId,
        createAgentAdapterSchema.parse(req.body),
      );
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/agent-adapters/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return externalAgents.getAdapter(accountId, idParams.parse(req.params).id);
    });

    app.patch('/api/v1/agent-adapters/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      await externalAgents.getAdapter(accountId, id);
      return externalAgents.updateAdapter(accountId, id, updateAgentAdapterSchema.parse(req.body));
    });

    app.delete('/api/v1/agent-adapters/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await externalAgents.deleteAdapter(accountId, idParams.parse(req.params).id);
      return { ok: true };
    });

    // Start the agent in that session's sandbox and run the handshake only.
    app.post('/api/v1/agent-adapters/:id/check', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      await externalAgents.getAdapter(accountId, id);
      const body = checkBody.parse(req.body);
      return externalAgents.checkAdapter(accountId, id, sessionThread(accountId, body.sessionId));
    });

    // ---- delegations from Code sessions (FR-203) ------------------------------------------------
    app.get('/api/v1/code/sessions/:id/delegations', async (req) => {
      const accountId = await ctx.accountOf(req);
      await externalAgents.listAdapters(accountId);
      const threadId = sessionThread(accountId, idParams.parse(req.params).id);
      return { items: await externalAgents.listDelegations(accountId, threadId) };
    });

    app.post('/api/v1/code/sessions/:id/delegations', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      await externalAgents.listAdapters(accountId);
      const threadId = sessionThread(accountId, idParams.parse(req.params).id);
      const view = await externalAgents.delegate(
        accountId,
        threadId,
        createDelegationSchema.parse(req.body),
      );
      void reply.status(202);
      return view;
    });

    app.get('/api/v1/delegations/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return externalAgents.getDelegation(accountId, idParams.parse(req.params).id);
    });

    app.post('/api/v1/delegations/:id/cancel', async (req) => {
      const accountId = await ctx.accountOf(req);
      return externalAgents.cancel(accountId, idParams.parse(req.params).id);
    });
  }

  return Promise.resolve({
    tools,
    externalAgents,
    register,
    useRuntime: (r) => {
      runtime = r;
    },
    useGate: (g) => {
      gate = g;
    },
    useSandbox: (s, routed) => {
      sandbox = s;
      if (routed) forThread = routed;
    },
    close: () => {
      offSetting();
      return externalAgents.close();
    },
  });
}
