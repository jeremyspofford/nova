// Code sessions in the Hub (FR-061, FR-063..FR-066, FR-069, FR-073, FR-074, FR-211;
// contracts/hub-api.md "Code, tools, extensions"). The area owns the CodeService and its routes,
// and exports the runtime seams the loop and the gate consume: `policy` (ThreadPolicySource),
// `extension` (TurnExtension), `tools` (the coding tools, a ToolSourceProvider) and `status`
// (ThreadStatusSource). Changes are refreshed when a turn ends, when the diff is read and after
// every tool call on a code thread that may have written files (tool.call.completed), so a
// change carries the call that made it. The mode last used in a folder is saved in the
// `code.folderModes` setting.
//
// M6 (docs/10 §2, §7-§10): saved environments with health checks (FR-062, FR-078; the SSH helper
// transport and the device provider are bound late by the devices area), Git hosts, pushes and
// pull requests with CI polling and failure feedback (FR-070), the worktree registry (FR-073),
// dev servers whose URLs the browser pane opens (FR-097, FR-067; the egress proxy's dev-server
// grant is bound late by the computers area), auto-verify after edits (FR-068), cross-session
// operations and side questions (FR-072), workers (`task.spawn` with a worktree) and session
// budgets (docs/09 §2). `sandboxForThread` names the sandbox a session's commands use, for the
// tool runtime.
//
// M7 (docs/10 §2, §9, §15; FR-212, FR-213): session handoff (and a chat's move to another device),
// three-way merges with their conflicts, best-of-N attempts, Hub-side diff, review and commit for
// sessions on other machines, the SSH transport with host keys pinned on first use (behind
// `code.ssh.enabled`), delegation from agents (`code.delegate`, the agent's rules applied through
// `delegatedRules`), and the transport seam the cloud runner registers (`useEnvironmentTransport`).
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  commitSchema,
  createCodeSessionM6Schema,
  createGitHostSchema,
  createPullRequestSchema,
  createWorktreeSchema,
  diffCommentsSchema,
  environmentOutputQuery,
  extendCodeBudgetSchema,
  hunkDecisionSchema,
  idSchema,
  isNovaError,
  pushSchema,
  removeWorktreeQuery,
  renewWorktreeSchema,
  sideQuestionSchema,
  startDevServerSchema,
  updateCodeSessionSchema,
  updateEnvironmentSchema,
  worktreeListQuery,
  applyAttemptSchema,
  mergeSchema,
  sessionHandoffSchema,
  startAttemptsSchema,
  threadHandoffSchema,
  type CodeSessionExtrasView,
  type PermissionMode,
} from '@nova/shared';
import {
  AttemptService,
  AutoVerifier,
  CodeDelegations,
  CodeService,
  CodeSessionOps,
  HandoffService,
  MergeService,
  OpenSshTransport,
  DevServerManager,
  GitHostService,
  PullRequestService,
  codeAreaToolSource,
  codeM6Tools,
  codeToolSource,
  detectSandbox,
  noopAudit,
  type AuditSink,
  type AgentRuleSource,
  type CodeAgentHost,
  type DevServerGrant,
  type DevServerOpener,
  type EnvironmentTransportProvider,
  type ToolLimitSource,
  type EnvDeviceProvider,
  type EnvSshTransport,
  type GitHostClient,
  type SandboxClient,
  type SandboxEgress,
  type TerminalManager,
  type ThreadPolicySource,
  type ThreadStatusSource,
  type ToolSourceProvider,
  type TurnExtension,
  type TurnStarter,
} from '@nova/core';
import { schema } from '@nova/storage';
import { and, eq } from 'drizzle-orm';
import type { HubArea, HubContext } from './hub-context.ts';

export interface CodeArea extends HubArea {
  service: CodeService;
  /** Connected Git hosts (FR-070). */
  hosts: GitHostService;
  /** Pushes, pull requests and CI status (FR-070). */
  prs: PullRequestService;
  /** Dev servers of sessions (FR-097). */
  devServers: DevServerManager;
  /** Auto-verify after edits (FR-068). */
  verifier: AutoVerifier;
  /** Cross-session operations and workers (FR-072, FR-073). */
  ops: CodeSessionOps;
  /** Session handoffs and chat moves (FR-213). */
  handoffs: HandoffService;
  /** Three-way merges onto a session (FR-073). */
  merges: MergeService;
  /** Best-of-N attempts (FR-212). */
  attempts: AttemptService;
  /** Code sessions agents start (`code.delegate`). */
  delegations: CodeDelegations;
  /** The agents area's thread links, main threads and budgets (late-bound; delegation). */
  useAgents(host: CodeAgentHost): void;
  /**
   * The gate's agent rules with delegated Code sessions included: wire it as
   * `policy.useAgentPolicy(code.delegatedRules(agents.agentPolicy))`.
   */
  delegatedRules(inner: AgentRuleSource): AgentRuleSource;
  /**
   * The agent's connected plugins for the sessions it started and their workers: wire it as
   * `policy.gate.useToolLimits(code.delegatedToolLimits(agents.service.toolLimits))`.
   */
  delegatedToolLimits(inner: ToolLimitSource): ToolLimitSource;
  /** The transport of sessions in an environment kind another area runs (cloud runner). */
  useEnvironmentTransport(kind: 'cloud', provider: EnvironmentTransportProvider): void;
  /** A Code session's permission mode as approval policy, profile and roots (the gate). */
  policy: ThreadPolicySource;
  /**
   * The same for the tool scope (M7): a session on another machine (SSH, WSL, a device) gets no
   * root on the Hub. Wire it as `tools.useThreadPolicy(code.toolPolicy)`.
   */
  toolPolicy: ThreadPolicySource;
  /** The Environment block and the change refresh for each turn of a code thread. */
  extension: TurnExtension;
  /** git.status, git.diff, git.log, test.run, code.symbols, code.refs (source `builtin`). */
  tools: ToolSourceProvider;
  /**
   * The M6 tools (source `builtin`): in Code threads git.branch, git.commit, pr.create,
   * pr.status, devserver.*, task.spawn and task.wait, and the cross-session sessions.* tools,
   * which agent threads get too.
   */
  toolsM6: ToolSourceProvider;
  /** Blocked when the environment is down or the folder is gone (FR-215). */
  status: ThreadStatusSource;
  /** Comments submitted to the agent start a turn (FR-065). */
  useTurns(starter: TurnStarter): void;
  /** Terminals in the session folder (FR-066). */
  useTerminals(terminals: TerminalManager): void;
  /** The devices area's connections to `novad` on devices (device and WSL environments). */
  useDevices(provider: EnvDeviceProvider): void;
  /** `novad` over SSH (the devices area builds it). */
  useSsh(transport: EnvSshTransport): void;
  /** The egress proxy's dev-server grant (computers area). */
  useDevServerGrant(grant: DevServerGrant): void;
  /** The browser pane's controller opening a dev server's URL (browser area). */
  useBrowserOpener(opener: DevServerOpener): void;
  /**
   * The sandbox a Code thread's commands run in: null for the Hub's own (local sessions and
   * other threads); a container environment's image; the helper of an ssh, wsl or device one.
   */
  sandboxForThread(accountId: string, threadId: string): SandboxClient | null;
}

export interface CodeDeps {
  audit?: AuditSink;
  /** The tools' sandbox (late-bound): commit hooks run in it; Bypass needs a VM or container. */
  sandbox?: () => SandboxClient | null;
  terminals?: TerminalManager;
  turns?: TurnStarter;
  /** The Hub user's home folder (`~`); defaults to the real one. */
  home?: string | null;
  /** How often archived sessions release their worktrees (default 5 min). */
  sweepIntervalMs?: number;
  /** A sandbox for a container environment's image (default: docker or podman with it). */
  containerSandbox?: (image: string) => SandboxClient | null;
  /**
   * The egress proxy (late-bound, the computers area's): a container environment reaches the
   * network only through it, like every other sandbox (docs/12 §8).
   */
  egress?: () => SandboxEgress | null;
  /** `novad` over SSH; usually bound later with `useSsh`. */
  sshTransport?: EnvSshTransport;
  /** Build Git host clients (tests point them at a mock host). */
  gitHostClient?: (host: { kind: 'github'; apiUrl: string; token: string }) => GitHostClient;
  /** How often open pull requests are checked for due CI polls (default 15 s). */
  ciTickMs?: number;
  /** How long a dev server start waits for an early exit (default 3 s). */
  devServerYieldMs?: number;
  /** How long a handoff waits for a running turn (default 30 min). */
  handoffTurnWaitMs?: number;
  /** The ssh client the default SSH transport runs (tests point it at a stand-in). */
  sshClient?: { bin: string; env?: Record<string, string>; multiplex?: boolean };
}

/** Tools that never write files: no refresh after them. */
const READ_ONLY_TOOLS =
  /^(fs\.(read|list|search)|git\.(status|diff|log)|code\.(symbols|refs)|web\.\w+|tool\.search|artifact\.\w+|context\.\w+|pr\.status|devserver\.list|sessions\.(list|ask)|task\.wait)$/;
/** Folders remembered in `code.folderModes` at most (oldest dropped first). */
const MAX_FOLDER_MODES = 200;

const idParams = z.object({ id: idSchema });
const changeParams = z.object({ id: idSchema, changeId: idSchema });
const commentParams = z.object({ id: idSchema, commentId: idSchema });
const reviewParams = z.object({ id: idSchema, reviewId: idSchema });
const listQuery = z.object({ archived: z.enum(['true', 'false']).optional() });
const decideAllBody = z
  .object({ changeIds: z.array(idSchema).min(1).max(1000).optional() })
  .strict();
const symbolsQuery = z.object({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const refsQuery = z.object({
  name: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const terminalBody = z
  .object({
    cols: z.number().int().min(10).max(500).default(100),
    rows: z.number().int().min(5).max(200).default(30),
  })
  .strict();
const processParams = z.object({ id: idSchema, processId: z.string().min(1).max(100) });
const serverParams = z.object({ id: idSchema, serverId: idSchema });
const verifyParams = z.object({ id: idSchema, verifyId: idSchema });
const wslQuery = z.object({ deviceId: idSchema });
const mergeParams = z.object({ id: idSchema, mergeId: idSchema });
const setParams = z.object({ setId: idSchema });
const branchBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export function setupCode(ctx: HubContext & CodeDeps): Promise<CodeArea> {
  const log = ctx.log.child('code');
  const audit = ctx.audit ?? noopAudit;
  const service = new CodeService({
    db: ctx.db,
    events: ctx.events,
    audit,
    threads: ctx.threads,
    router: ctx.router,
    dataDir: ctx.dataDir,
    setting: ctx.setting,
    rememberMode: (accountId, folder, mode) => rememberMode(ctx, accountId, folder, mode),
    sandbox: () => ctx.sandbox?.() ?? null,
    ...(ctx.home !== undefined ? { home: ctx.home } : {}),
    secrets: ctx.secrets,
    // A container environment runs its image on the same engine as the tools' sandbox, with the
    // network only through the egress proxy (none without it, fail closed).
    containerSandbox:
      ctx.containerSandbox ??
      ((image) => {
        const egress = ctx.egress?.() ?? null;
        return detectSandbox({
          mode: process.env.NOVA_SANDBOX ?? 'auto',
          image,
          deniedPaths: [ctx.dataDir],
          ...(egress ? { egress } : {}),
        });
      }),
    // The system's OpenSSH client, off until `code.ssh.enabled` (M7, docs/10 §2).
    sshTransport:
      ctx.sshTransport ??
      new OpenSshTransport({
        runDir: join(ctx.dataDir, 'code', 'ssh'),
        enabled: () => ctx.setting('code.ssh.enabled'),
        ...(ctx.sshClient
          ? {
              sshBin: ctx.sshClient.bin,
              ...(ctx.sshClient.env ? { env: ctx.sshClient.env } : {}),
              ...(ctx.sshClient.multiplex !== undefined
                ? { multiplex: ctx.sshClient.multiplex }
                : {}),
            }
          : {}),
        log,
      }),
    log,
  });
  if (ctx.terminals) service.useTerminals(ctx.terminals);
  if (ctx.turns) service.useTurns(ctx.turns);
  const hosts = new GitHostService({
    db: ctx.db,
    secrets: ctx.secrets,
    audit,
    ...(ctx.gitHostClient ? { client: ctx.gitHostClient } : {}),
  });
  const prs = new PullRequestService({
    db: ctx.db,
    code: service,
    hosts,
    audit,
    setting: ctx.setting,
    log,
  });
  const devServers = new DevServerManager({
    code: service,
    audit,
    ...(ctx.devServerYieldMs !== undefined ? { startYieldMs: ctx.devServerYieldMs } : {}),
    log,
  });
  const verifier = new AutoVerifier({ db: ctx.db, code: service, setting: ctx.setting, log });
  service.useTurnEndHook(verifier.onTurnEnd);
  const ops = new CodeSessionOps({
    code: service,
    threads: ctx.threads,
    router: ctx.router,
    audit,
  });
  const merges = new MergeService({
    db: ctx.db,
    code: service,
    events: ctx.events,
    audit,
    dataDir: ctx.dataDir,
    log,
  });
  service.useCommitGuard(merges.commitGuard);
  const handoffs = new HandoffService({
    db: ctx.db,
    code: service,
    threads: ctx.threads,
    events: ctx.events,
    audit,
    dataDir: ctx.dataDir,
    setting: ctx.setting,
    ...(ctx.handoffTurnWaitMs !== undefined ? { turnWaitMs: ctx.handoffTurnWaitMs } : {}),
    log,
  });
  const attempts = new AttemptService({
    db: ctx.db,
    code: service,
    merges,
    verifier,
    audit,
    setting: ctx.setting,
    log,
  });
  const delegations = new CodeDelegations({
    db: ctx.db,
    code: service,
    audit,
    setting: ctx.setting,
    log,
  });
  const tools = codeToolSource(service);
  const toolsM6 = codeAreaToolSource([], {
    ...codeM6Tools({ code: service, prs, devServers, ops }),
    agent: [delegations.tool()],
  });

  // A tool call on a code thread may have changed files: capture them with its call id.
  const off = ctx.events.bus.subscribe('tool.call.completed', (e) => {
    const p = e.payload as {
      callId?: unknown;
      tool?: unknown;
      status?: unknown;
      threadId?: unknown;
    };
    if (!e.accountId || typeof p.threadId !== 'string' || typeof p.callId !== 'string') return;
    if (typeof p.tool === 'string' && READ_ONLY_TOOLS.test(p.tool)) return;
    if (p.status === 'denied') return;
    service
      .refreshThread(e.accountId, p.threadId, p.callId)
      .catch((err: unknown) => log.warn('refreshing code changes failed', { err }));
  });
  // An agent paused, resumed or deleted: its delegated work is held, released or cancelled.
  const offAgentStatus = ctx.events.bus.subscribe('agent.status.changed', (e) => {
    const p = e.payload as { agentId?: unknown; to?: unknown };
    if (!e.accountId || typeof p.agentId !== 'string') return;
    delegations
      .agentChanged(e.accountId, p.agentId, p.to === 'active' ? 'active' : 'paused')
      .catch((err: unknown) => log.warn('holding delegated work failed', { err }));
  });
  const offAgentDeleted = ctx.events.bus.subscribe('agent.deleted', (e) => {
    const p = e.payload as { agentId?: unknown };
    if (!e.accountId || typeof p.agentId !== 'string') return;
    delegations
      .agentChanged(e.accountId, p.agentId, 'deleted')
      .catch((err: unknown) => log.warn('cancelling delegated work failed', { err }));
  });
  const sweep = async () => {
    await service.sweepArchived();
    await service.worktrees.sweepExpired();
    const active = new Set(service.activeSessionIds());
    await devServers.stopInactive((id) => active.has(id));
    await service.envs.checkInUse();
    // Handoff patches and bundles expire (M7).
    await handoffs.sweepFiles();
  };
  const sweeper = setInterval(
    () => {
      sweep().catch((err: unknown) => log.warn('code session sweep failed', { err }));
    },
    ctx.sweepIntervalMs ?? 5 * 60_000,
  );
  sweeper.unref();
  // CI of open pull requests is read every `code.ciPollSeconds`; this tick finds the due ones.
  const ciTicker = setInterval(() => {
    prs.pollDue().catch((err: unknown) => log.warn('CI polling failed', { err }));
  }, ctx.ciTickMs ?? 15_000);
  ciTicker.unref();

  return Promise.resolve({
    service,
    hosts,
    prs,
    devServers,
    verifier,
    ops,
    handoffs,
    merges,
    attempts,
    delegations,
    useAgents: (host) => delegations.useAgents(host),
    delegatedRules: (inner) => delegations.delegatedRules(inner),
    delegatedToolLimits: (inner) => delegations.delegatedToolLimits(inner),
    useEnvironmentTransport: (kind, provider) => service.useEnvironmentTransport(kind, provider),
    policy: service.policy,
    toolPolicy: service.toolPolicy,
    extension: service.extension,
    tools,
    toolsM6,
    status: service.status,
    useTurns: (starter) => service.useTurns(starter),
    useTerminals: (terminals) => service.useTerminals(terminals),
    useDevices: (provider) => service.envs.useDevices(provider),
    useSsh: (transport) => service.envs.useSsh(transport),
    useDevServerGrant: (grant) => devServers.useGrant(grant),
    useBrowserOpener: (opener) => devServers.useOpener(opener),
    sandboxForThread: (accountId, threadId) => service.sandboxForThread(accountId, threadId),
    register(app: FastifyInstance) {
      // ---- environments (FR-062, FR-078) ---------------------------------------------------
      app.get('/api/v1/environments', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await service.envs.list(accountId) };
      });

      app.post('/api/v1/environments', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const view = await service.envs.create(accountId, req.body);
        void reply.status(201);
        return view;
      });

      app.get('/api/v1/environments/wsl/distros', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = wslQuery.parse(req.query);
        return { items: await service.envs.wslDistros(accountId, q.deviceId) };
      });

      app.get('/api/v1/environments/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.envs.get(accountId, idParams.parse(req.params).id);
      });

      app.patch('/api/v1/environments/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return service.envs.update(accountId, id, updateEnvironmentSchema.parse(req.body));
      });

      app.delete('/api/v1/environments/:id', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        await service.envs.remove(accountId, idParams.parse(req.params).id);
        return reply.status(204).send();
      });

      app.post('/api/v1/environments/:id/check', async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.envs.check(accountId, idParams.parse(req.params).id);
      });

      // M7: forget a pinned SSH host key on purpose (the next connection pins anew).
      app.post('/api/v1/environments/:id/hostkey/reset', async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.envs.resetHostKey(accountId, idParams.parse(req.params).id);
      });

      app.get('/api/v1/environments/:id/processes', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await service.envs.processes(accountId, idParams.parse(req.params).id) };
      });

      app.get('/api/v1/environments/:id/processes/:processId/output', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = processParams.parse(req.params);
        const q = environmentOutputQuery.parse(req.query);
        return service.envs.output(accountId, p.id, p.processId, q.offset);
      });

      // ---- Git hosts (FR-070) --------------------------------------------------------------
      app.get('/api/v1/code/githosts', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: hosts.list(accountId) };
      });

      app.post('/api/v1/code/githosts', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const view = await hosts.create(accountId, createGitHostSchema.parse(req.body));
        void reply.status(201);
        return view;
      });

      app.post('/api/v1/code/githosts/:id/check', async (req) => {
        const accountId = await ctx.accountOf(req);
        return hosts.check(accountId, idParams.parse(req.params).id);
      });

      app.delete('/api/v1/code/githosts/:id', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        await hosts.remove(accountId, idParams.parse(req.params).id);
        return reply.status(204).send();
      });

      // ---- worktree registry (FR-073) ------------------------------------------------------
      app.get('/api/v1/code/worktrees', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = worktreeListQuery.parse(req.query);
        // Worktrees on devices come with device sessions; the Hub's own are listed.
        if (q.deviceId) return { items: [] };
        return {
          items: await service.listWorktrees(accountId, {
            ...(q.repo ? { repo: q.repo } : {}),
            ...(q.status ? { status: q.status } : {}),
          }),
        };
      });

      app.post('/api/v1/code/worktrees', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const view = await service.createWorktree(accountId, createWorktreeSchema.parse(req.body));
        void reply.status(201);
        return view;
      });

      app.post('/api/v1/code/worktrees/:id/renew', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const body = renewWorktreeSchema.parse(req.body ?? {});
        return service.worktrees.renew(accountId, id, body.ttlMinutes);
      });

      app.post('/api/v1/code/worktrees/:id/release', async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.worktrees.release(accountId, idParams.parse(req.params).id);
      });

      app.delete('/api/v1/code/worktrees/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const q = removeWorktreeQuery.parse(req.query);
        return service.worktrees.remove(accountId, id, q.force === 'true');
      });

      // ---- sessions (FR-061, FR-063) -----------------------------------------------------
      app.get('/api/v1/code/sessions', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = listQuery.parse(req.query);
        return { items: await service.list(accountId, { archived: q.archived === 'true' }) };
      });

      app.post('/api/v1/code/sessions', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const view = await service.create(accountId, createCodeSessionM6Schema.parse(req.body));
        void reply.status(201);
        return view;
      });

      app.get('/api/v1/code/sessions/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.get(accountId, idParams.parse(req.params).id);
      });

      app.patch('/api/v1/code/sessions/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return service.update(accountId, id, updateCodeSessionSchema.parse(req.body));
      });

      // ---- changes and review (FR-064, FR-065) -------------------------------------------
      app.get('/api/v1/code/sessions/:id/changes', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await service.changes(accountId, idParams.parse(req.params).id) };
      });

      app.post('/api/v1/code/sessions/:id/changes/:changeId/hunks', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = changeParams.parse(req.params);
        return service.decideHunks(accountId, p.id, p.changeId, hunkDecisionSchema.parse(req.body));
      });

      for (const action of ['accept', 'reject'] as const) {
        app.post(`/api/v1/code/sessions/:id/changes/${action}`, async (req) => {
          const accountId = await ctx.accountOf(req);
          const { id } = idParams.parse(req.params);
          const body = decideAllBody.parse(req.body ?? {});
          return {
            items: await service.decideAll(accountId, id, action === 'accept', body.changeIds),
          };
        });
      }

      app.get('/api/v1/code/sessions/:id/comments', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: service.comments(accountId, idParams.parse(req.params).id) };
      });

      app.post('/api/v1/code/sessions/:id/comments', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const items = await service.addComments(accountId, id, diffCommentsSchema.parse(req.body));
        void reply.status(201);
        return { items };
      });

      app.post('/api/v1/code/sessions/:id/comments/:commentId/resolve', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = commentParams.parse(req.params);
        return service.resolveComment(accountId, p.id, p.commentId);
      });

      // ---- review (FR-069) ---------------------------------------------------------------
      app.post('/api/v1/code/sessions/:id/review', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { view, done } = await service.startReview(accountId, idParams.parse(req.params).id);
        done.catch((err: unknown) => log.warn('code review failed', { err }));
        void reply.status(202);
        return view;
      });

      app.get('/api/v1/code/sessions/:id/reviews/:reviewId', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = reviewParams.parse(req.params);
        return service.review(accountId, p.id, p.reviewId);
      });

      // ---- commit (docs/10 §8) -----------------------------------------------------------
      app.post('/api/v1/code/sessions/:id/commit', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return service.commit(accountId, id, commitSchema.parse(req.body));
      });

      // ---- repo index (FR-074) -----------------------------------------------------------
      app.get('/api/v1/code/sessions/:id/symbols', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const q = symbolsQuery.parse(req.query);
        // Paths relative to the repository root (the session folder outside Git).
        return { items: await service.symbols(accountId, id, q.q, q.limit, 'repo') };
      });

      app.get('/api/v1/code/sessions/:id/refs', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const q = refsQuery.parse(req.query);
        return { items: await service.refs(accountId, id, q.name, q.limit, 'repo') };
      });

      // ---- M6 session facts, budgets and branches -------------------------------------------
      app.get('/api/v1/code/sessions/:id/extras', async (req): Promise<CodeSessionExtrasView> => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const info = service.info(accountId, id);
        const env = info.environmentId
          ? await service.envs.get(accountId, info.environmentId).catch(() => null)
          : null;
        const lineage = service.lineage(id);
        return {
          sessionId: id,
          environment: env ? { id: env.id, kind: env.kind, label: env.label } : null,
          parentSessionId: lineage.parentSessionId,
          role: lineage.role,
          setup: service.setupState(id),
          budget: service.budget(accountId, id),
          pullRequest: prs.get(accountId, id),
          lastVerify: verifier.list(accountId, id, 1)[0] ?? null,
          devServers: await devServers.list(accountId, id),
        };
      });

      app.post('/api/v1/code/sessions/:id/budget/extend', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return service.extendBudget(accountId, id, extendCodeBudgetSchema.parse(req.body));
      });

      app.post('/api/v1/code/sessions/:id/branch', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return service.createBranch(accountId, id, branchBody.parse(req.body).name, 'user');
      });

      // ---- pushes and pull requests (FR-070) ----------------------------------------------
      app.post('/api/v1/code/sessions/:id/push', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return prs.push(accountId, id, pushSchema.parse(req.body ?? {}), 'user');
      });

      app.post('/api/v1/code/sessions/:id/pr', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const view = await prs.open(accountId, id, createPullRequestSchema.parse(req.body), 'user');
        void reply.status(201);
        return view;
      });

      app.get('/api/v1/code/sessions/:id/pr', async (req) => {
        const accountId = await ctx.accountOf(req);
        const view = prs.get(accountId, idParams.parse(req.params).id);
        if (!view) throw new NovaError('not_found', 'this session has no pull request');
        return view;
      });

      app.post('/api/v1/code/sessions/:id/pr/refresh', async (req) => {
        const accountId = await ctx.accountOf(req);
        return prs.refresh(accountId, idParams.parse(req.params).id);
      });

      // ---- dev servers (FR-097, FR-067) ---------------------------------------------------
      app.get('/api/v1/code/sessions/:id/devservers', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return {
          candidates: await devServers.detect(accountId, id),
          items: await devServers.list(accountId, id),
        };
      });

      app.post('/api/v1/code/sessions/:id/devservers', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const body = startDevServerSchema.parse(req.body ?? {});
        try {
          const view = await devServers.start(accountId, id, body, 'user');
          void reply.status(201);
          return view;
        } catch (err) {
          if (isNovaError(err) && err.code === 'sandbox_unavailable')
            return reply.status(409).send({ error: err.toJSON(), requestId: req.id });
          throw err;
        }
      });

      app.post('/api/v1/code/sessions/:id/devservers/stop-all', async (req) => {
        const accountId = await ctx.accountOf(req);
        return {
          items: await devServers.stopAll(accountId, idParams.parse(req.params).id, 'user'),
        };
      });

      app.post('/api/v1/code/sessions/:id/devservers/:serverId/stop', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = serverParams.parse(req.params);
        return devServers.stop(accountId, p.id, p.serverId, 'user');
      });

      // ---- auto-verify (FR-068) -----------------------------------------------------------
      app.get('/api/v1/code/sessions/:id/verify', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: verifier.list(accountId, idParams.parse(req.params).id) };
      });

      app.post('/api/v1/code/sessions/:id/verify', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { view, done } = await verifier.run(accountId, idParams.parse(req.params).id);
        done.catch((err: unknown) => log.warn('verify failed', { err }));
        void reply.status(202);
        return view;
      });

      app.get('/api/v1/code/sessions/:id/verify/:verifyId', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = verifyParams.parse(req.params);
        return verifier.get(accountId, p.id, p.verifyId);
      });

      // ---- side questions (FR-072) --------------------------------------------------------
      app.post('/api/v1/code/sessions/:id/ask', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return ops.ask(accountId, id, sideQuestionSchema.parse(req.body).question);
      });

      // ---- M7: handoff (FR-213) -------------------------------------------------------------
      app.post('/api/v1/code/sessions/:id/handoff', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const { view, done } = await handoffs.start(
          accountId,
          id,
          sessionHandoffSchema.parse(req.body),
        );
        done.catch((err: unknown) => log.warn('handoff failed', { err }));
        void reply.status(202);
        return view;
      });

      app.get('/api/v1/code/sessions/:id/handoffs', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: handoffs.list(accountId, idParams.parse(req.params).id) };
      });

      app.get('/api/v1/handoffs/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        return handoffs.get(accountId, idParams.parse(req.params).id);
      });

      app.post('/api/v1/threads/:id/handoff', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        return handoffs.startChat(accountId, id, threadHandoffSchema.parse(req.body));
      });

      // ---- M7: three-way merges (FR-073) ------------------------------------------------------
      app.post('/api/v1/code/sessions/:id/merge', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const body = mergeSchema.parse(req.body);
        const view =
          'sessionId' in body.from
            ? await merges.mergeSession(accountId, id, body.from.sessionId, body.onConflict)
            : await merges.mergePatch(
                accountId,
                id,
                body.from.patch,
                body.from.base,
                body.onConflict,
              );
        void reply.status(201);
        return view;
      });

      app.get('/api/v1/code/sessions/:id/merges', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: merges.list(accountId, idParams.parse(req.params).id) };
      });

      app.get('/api/v1/code/sessions/:id/merges/:mergeId', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = mergeParams.parse(req.params);
        return merges.get(accountId, p.id, p.mergeId);
      });

      app.post('/api/v1/code/sessions/:id/merges/:mergeId/resolve', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = mergeParams.parse(req.params);
        return merges.resolve(accountId, p.id, p.mergeId);
      });

      app.post('/api/v1/code/sessions/:id/merges/:mergeId/abort', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = mergeParams.parse(req.params);
        return merges.abort(accountId, p.id, p.mergeId);
      });

      // ---- M7: best-of-N attempts (FR-212) ----------------------------------------------------
      app.post('/api/v1/code/sessions/:id/attempts', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const view = await attempts.start(accountId, id, startAttemptsSchema.parse(req.body));
        void reply.status(201);
        return view;
      });

      app.get('/api/v1/code/sessions/:id/attempts', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await attempts.list(accountId, idParams.parse(req.params).id) };
      });

      app.get('/api/v1/code/attempts/:setId', async (req) => {
        const accountId = await ctx.accountOf(req);
        return attempts.get(accountId, setParams.parse(req.params).setId);
      });

      app.post('/api/v1/code/attempts/:setId/apply', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { setId } = setParams.parse(req.params);
        return attempts.apply(accountId, setId, applyAttemptSchema.parse(req.body));
      });

      app.post('/api/v1/code/attempts/:setId/discard', async (req) => {
        const accountId = await ctx.accountOf(req);
        return attempts.discard(accountId, setParams.parse(req.params).setId);
      });

      // ---- terminal (FR-066) -------------------------------------------------------------
      app.post('/api/v1/code/sessions/:id/terminal', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const size = terminalBody.parse(req.body ?? {});
        try {
          const view = await service.openTerminal(accountId, id, size);
          void reply.status(201);
          return view;
        } catch (err) {
          // Without a sandbox nothing can run here: a state conflict, as for /terminals.
          if (isNovaError(err) && err.code === 'sandbox_unavailable')
            return reply.status(409).send({ error: err.toJSON(), requestId: req.id });
          throw err;
        }
      });
    },
    async close() {
      off();
      offAgentStatus();
      offAgentDeleted();
      clearInterval(sweeper);
      clearInterval(ciTicker);
      await handoffs.close();
      await attempts.close();
      await delegations.close();
      await devServers.close();
      await verifier.close();
      await service.close();
    },
  });
}

/**
 * Save the mode last used in a folder (`code.folderModes`, global scope; Plan is never saved,
 * FR-063) and announce the change like any settings write.
 */
async function rememberMode(
  ctx: HubContext,
  accountId: string,
  folder: string,
  mode: PermissionMode,
): Promise<void> {
  if (mode === 'plan') return;
  const current = { ...(await ctx.setting('code.folderModes')) };
  delete current[folder];
  current[folder] = mode;
  const keys = Object.keys(current);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FOLDER_MODES))) delete current[k];
  const value = SETTINGS['code.folderModes'].schema.parse(current);
  const now = new Date().toISOString();
  const { setting } = schema;
  await ctx.db.transaction(async () => {
    await ctx.db.orm
      .delete(setting)
      .where(
        and(
          eq(setting.key, 'code.folderModes'),
          eq(setting.scopeKind, 'global'),
          eq(setting.scopeRef, ''),
        ),
      );
    await ctx.db.orm.insert(setting).values({
      key: 'code.folderModes',
      scopeKind: 'global',
      scopeRef: '',
      valueJson: JSON.stringify(value),
      updatedAt: now,
    });
  });
  await ctx.events.emit({
    name: 'settings.changed',
    actor: 'user',
    accountId,
    payload: { key: 'code.folderModes', scope: 'global' },
  });
}
