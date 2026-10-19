// Always-on agents (docs/09 §8; FR-079, FR-080, FR-082..FR-084, FR-089, FR-090, FR-181, FR-194,
// FR-206, FR-059, FR-072; contracts/hub-api.md "Tasks, goals, agents"). The routes over the
// AgentService, plus what other areas wire late: the chat loop that runs agent turns
// (`useTurns`; add `extension` to the loop's turn extensions), Work runs for delegation and the
// pause cascade (`useRuns`), the scheduler for agent schedules and self-set wakes (`useScheduler`,
// and the scheduler's `useAgents(scheduleTarget)`), the agent's computer (`useComputers`), quiet
// hours (`useQuietHours`), the derived status (`useStatus`) and revocation on delete
// (`onDelete`). `policy` is a per-thread policy source for the gate and the tools; `agentPolicy`
// carries the agent's rules to the gate. Every route needs a session and validates its body;
// every change is audited (kind `agent`).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENT_DELETE_NOTICE,
  createAgentNoteSchema,
  createAgentRuleSchema,
  createAgentSchema,
  deleteAgentSchema,
  externalAgentSchema,
  idSchema,
  NovaError,
  responsibilitySchema,
  scheduleSchema,
  setAgentGoalSchema,
  updateAgentMemorySchema,
  updateAgentRuleSchema,
  updateAgentSchema,
  updateResponsibilitySchema,
} from '@nova/shared';
import {
  AgentService,
  type AgentComputers,
  type AgentDeleteHook,
  type AgentFireTarget,
  type AgentPolicySource,
  type AgentRuns,
  type AgentScheduler,
  type AgentStatusLookup,
  type AgentTimers,
  type AuditSink,
  type ExternalAgentGuard,
  type Notifier,
  type QuietHours,
  type ThreadPolicySource,
  type ThreadStatusSource,
  type ToolSourceProvider,
  type TurnExtension,
  type TurnStarter,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface AgentsArea extends HubArea {
  service: AgentService;
  /** Add to the chat loop's turn extensions: context, budgets and onEnd for agent threads. */
  extension: TurnExtension;
  /** An agent's autonomy and a research thread's read-only profile, for the gate and tools. */
  policy: ThreadPolicySource;
  /** The agent's rules (and the research deny) for the gate, scoped to the thread (FR-084). */
  agentPolicy: AgentPolicySource;
  /** Safety pauses and blocked goals for the derived status; research and runs as children. */
  status: ThreadStatusSource;
  /** The agent tools as one source (they refuse outside agent threads). */
  tools: ToolSourceProvider;
  /** For the scheduler's `useAgents`: fires of agent-targeted schedules and wakes. */
  scheduleTarget: AgentFireTarget;
  /** FR-194, for the channels and browser areas. */
  externalAgentGuard: ExternalAgentGuard;
  /** The private-to-shared check of the channels area (FR-088). */
  memory: AgentService['memory'];
  /**
   * For `channels.useAgents`: a binding's thread (BindingThreadResolver, ADR-070) and an
   * agent's main thread (where trigger wakes run).
   */
  channels: {
    threadFor: AgentService['bindingThread'];
    agentThread: (accountId: string, agentId: string) => Promise<string>;
  };
  useTurns(starter: TurnStarter): void;
  useRuns(runs: AgentRuns): void;
  useScheduler(scheduler: AgentScheduler): void;
  useComputers(computers: AgentComputers): void;
  useQuietHours(fn: QuietHours): void;
  useStatus(fn: AgentStatusLookup): void;
  onDelete(hook: AgentDeleteHook): void;
}

export interface AgentsDeps {
  audit?: AuditSink;
  notifier?: Notifier;
  /** Tests: a simulated clock and timers. */
  now?: () => Date;
  timers?: AgentTimers;
  goalDebounceMs?: number;
  proactiveCheckMs?: number;
}

/** An avatar is at most 2 MB, sent as base64 inside JSON (as the account's). */
export const AGENT_BODY_LIMIT = 4 * 1024 * 1024;

const params = z.object({ id: idSchema });
const subParams = z.object({ id: idSchema, sub: idSchema });
const emptyBody = z.object({}).passthrough().optional();
const suggestionsQuery = z.object({ status: z.enum(['open', 'accepted', 'dismissed']).optional() });
const previewQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function setupAgents(ctx: HubContext & AgentsDeps): Promise<AgentsArea> {
  const log = ctx.log.child('agents');
  const service = new AgentService({
    db: ctx.db,
    events: ctx.events,
    threads: ctx.threads,
    dataDir: ctx.dataDir,
    settings: {
      defaultBudgets: () => ctx.setting('agents.defaultBudgets'),
      autonomy: () => ctx.setting('agents.autonomy'),
      proactive: () => ctx.setting('agents.proactive'),
      wakes: () => ctx.setting('agents.wakes'),
      reviewModel: () => ctx.setting('review.model'),
    },
    // A goal stopped by a usage limit is retried after this long, doubling (M7).
    usageRetryMs: async () => (await ctx.setting('agents.usageRetryMinutes')) * 60_000,
    log,
    ...(ctx.audit ? { audit: ctx.audit } : {}),
    ...(ctx.notifier ? { notifier: ctx.notifier } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(ctx.timers ? { timers: ctx.timers } : {}),
    ...(ctx.goalDebounceMs !== undefined ? { goalDebounceMs: ctx.goalDebounceMs } : {}),
    ...(ctx.proactiveCheckMs !== undefined ? { proactiveCheckMs: ctx.proactiveCheckMs } : {}),
  });
  // A proactive research turn may only read: an approval it asks for stops it (FR-082).
  const offApproval = ctx.events.bus.subscribe('approval.requested', (e) => {
    const threadId = e.correlation?.threadId;
    if (!threadId) return;
    service.onApprovalRequested(threadId).catch((err: unknown) => {
      log.warn('could not stop a research turn', { err });
    });
  });
  // Goal statuses the user changes through /goals/:id/{pause,resume,complete} (FR-181).
  const offGoal = ctx.events.bus.subscribe('goal.status.changed', (e) => {
    const goalId = e.payload.goalId;
    if (typeof goalId !== 'string') return;
    service.onGoalChanged(goalId).catch((err: unknown) => {
      log.warn('could not follow an agent goal', { err });
    });
  });
  service.start();

  ctx.diagnostics.add('agents', () => {
    const row = ctx.db.raw
      .prepare(
        `SELECT count(*) AS total, sum(status = 'active') AS active, sum(status = 'paused') AS paused
         FROM agent`,
      )
      .get() as { total: number; active: number | null; paused: number | null };
    return Promise.resolve({
      total: row.total,
      active: row.active ?? 0,
      paused: row.paused ?? 0,
    });
  });

  function register(app: FastifyInstance): void {
    // ---- agents (FR-079, FR-090) ------------------------------------------------------------
    app.get('/api/v1/agents', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.list(accountId) };
    });

    app.post('/api/v1/agents', { bodyLimit: AGENT_BODY_LIMIT }, async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = createAgentSchema.parse(req.body);
      return reply.status(201).send(await service.create(accountId, body));
    });

    app.get('/api/v1/agents/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.get(accountId, id);
    });

    app.patch('/api/v1/agents/:id', { bodyLimit: AGENT_BODY_LIMIT }, async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.update(accountId, id, updateAgentSchema.parse(req.body));
    });

    // Irreversible: the client shows AGENT_DELETE_NOTICE and sends {confirm: true} (FR-090).
    app.delete('/api/v1/agents/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      if (!deleteAgentSchema.safeParse(req.body ?? {}).success)
        throw new NovaError('validation', AGENT_DELETE_NOTICE, {
          details: { field: 'confirm', reason: 'confirmation_required' },
        });
      await service.remove(accountId, id);
      return { ok: true };
    });

    app.get('/api/v1/agents/:id/avatar', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const image = await service.avatar(accountId, id);
      if (!image) throw new NovaError('not_found', 'no avatar');
      void reply
        .header('Content-Type', image.mime)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, no-cache');
      return reply.send(image.bytes);
    });

    app.post('/api/v1/agents/:id/pause', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      emptyBody.parse(req.body);
      return service.pause(accountId, id);
    });

    app.post('/api/v1/agents/:id/resume', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      emptyBody.parse(req.body);
      return service.resume(accountId, id);
    });

    app.post('/api/v1/agents/:id/stop', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      emptyBody.parse(req.body);
      return service.stop(accountId, id);
    });

    // Proactive research now (FR-082): still read-only, still not while paused.
    app.post('/api/v1/agents/:id/research', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      emptyBody.parse(req.body);
      return reply.status(202).send(await service.researchNow(accountId, id));
    });

    app.get('/api/v1/agents/:id/activity', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.activity(accountId, id) };
    });

    app.get('/api/v1/agents/:id/threads', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.threadsOf(accountId, id) };
    });

    app.get('/api/v1/agents/:id/background', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.background(accountId, id) };
    });

    // ---- responsibilities (FR-079) -----------------------------------------------------------
    app.get('/api/v1/agents/:id/responsibilities', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.listResponsibilities(accountId, id) };
    });

    app.post('/api/v1/agents/:id/responsibilities', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const body = responsibilitySchema.parse(req.body);
      return reply.status(201).send(await service.addResponsibility(accountId, id, body));
    });

    app.patch('/api/v1/agents/:id/responsibilities/:sub', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      return service.updateResponsibility(
        accountId,
        id,
        sub,
        updateResponsibilitySchema.parse(req.body),
      );
    });

    app.delete('/api/v1/agents/:id/responsibilities/:sub', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      await service.removeResponsibility(accountId, id, sub);
      return { ok: true };
    });

    // ---- rules (FR-084) ------------------------------------------------------------------------
    app.get('/api/v1/agents/:id/rules', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.listRules(accountId, id) };
    });

    app.post('/api/v1/agents/:id/rules', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const body = createAgentRuleSchema.parse(req.body);
      return reply.status(201).send(await service.createRule(accountId, id, body));
    });

    app.patch('/api/v1/agents/:id/rules/:sub', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      return service.updateRule(accountId, id, sub, updateAgentRuleSchema.parse(req.body));
    });

    app.delete('/api/v1/agents/:id/rules/:sub', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      await service.deleteRule(accountId, id, sub);
      return { ok: true };
    });

    app.get('/api/v1/agents/:id/rules/:sub/preview', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      const { limit } = previewQuery.parse(req.query);
      return { items: await service.previewRule(accountId, id, sub, limit) };
    });

    // ---- memory (FR-089) -----------------------------------------------------------------------
    app.get('/api/v1/agents/:id/memory', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.listMemory(accountId, id) };
    });

    app.post('/api/v1/agents/:id/memory', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const body = createAgentNoteSchema.parse(req.body);
      return reply.status(201).send(await service.addNote(accountId, id, body));
    });

    app.patch('/api/v1/agents/:id/memory/:sub', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      return service.updateMemory(accountId, id, sub, updateAgentMemorySchema.parse(req.body));
    });

    app.delete('/api/v1/agents/:id/memory/:sub', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, sub } = subParams.parse(req.params);
      await service.deleteMemory(accountId, id, sub);
      return { ok: true };
    });

    // ---- suggestions (FR-082) ------------------------------------------------------------------
    app.get('/api/v1/agents/:id/suggestions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const { status } = suggestionsQuery.parse(req.query);
      return { items: await service.listSuggestions(accountId, id, status) };
    });

    for (const action of ['accept', 'dismiss'] as const) {
      app.post(`/api/v1/agents/:id/suggestions/:sub/${action}`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id, sub } = subParams.parse(req.params);
        emptyBody.parse(req.body);
        return service.decideSuggestion(accountId, id, sub, action);
      });
    }

    // ---- goal (FR-181) -------------------------------------------------------------------------
    app.get('/api/v1/agents/:id/goal', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      // An agent without a goal answers `null`, as a run's goal does.
      const goal = await service.getGoal(accountId, id);
      return reply.type('application/json').send(JSON.stringify(goal));
    });

    app.put('/api/v1/agents/:id/goal', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.setGoal(accountId, id, setAgentGoalSchema.parse(req.body));
    });

    app.delete('/api/v1/agents/:id/goal', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await service.clearGoal(accountId, id);
      return { ok: true };
    });

    // ---- schedules the user makes for an agent (FR-055, FR-059) ---------------------------------
    app.get('/api/v1/agents/:id/schedules', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return { items: await service.listSchedules(accountId, id) };
    });

    app.post('/api/v1/agents/:id/schedules', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      // The user's own schedule: its fires carry the user's authority (FR-189).
      const body = scheduleSchema.parse(req.body);
      return reply.status(201).send(await service.createSchedule(accountId, id, body));
    });

    // ---- external agents (FR-194) --------------------------------------------------------------
    app.get('/api/v1/external-agents', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.listExternal(accountId) };
    });

    app.post('/api/v1/external-agents', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = externalAgentSchema.parse(req.body);
      return reply.status(201).send(await service.markExternal(accountId, body));
    });

    app.delete('/api/v1/external-agents/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await service.unmarkExternal(accountId, id);
      return { ok: true };
    });
  }

  return Promise.resolve({
    service,
    extension: service.extension,
    policy: service.policy,
    agentPolicy: service.agentPolicy,
    status: service.status,
    tools: service.toolSource,
    scheduleTarget: service.scheduleTarget,
    externalAgentGuard: service.externalAgentGuard,
    memory: service.memory,
    channels: {
      threadFor: (input) => service.bindingThread(input),
      agentThread: (accountId, agentId) => service.mainThreadOf(accountId, agentId),
    },
    useTurns: (starter) => {
      service.useTurns(starter);
    },
    useRuns: (runs) => {
      service.useRuns(runs);
    },
    useScheduler: (scheduler) => {
      service.useScheduler(scheduler);
    },
    useComputers: (computers) => {
      service.useComputers(computers);
    },
    useQuietHours: (fn) => {
      service.useQuietHours(fn);
    },
    useStatus: (fn) => {
      service.useStatus(fn);
    },
    onDelete: (hook) => {
      service.onDelete(hook);
    },
    register,
    close: async () => {
      offApproval();
      offGoal();
      await service.close();
    },
  });
}
