// Work runs, goals and sub-agents (FR-051..FR-054, FR-057, FR-181, FR-182, FR-186, FR-187,
// FR-220; contracts/hub-api.md "Tasks, goals, agents"). The supervisor (RunService) runs each
// run's turns in the one chat loop: the lead binds the ChatService with `useTurns`, adds
// `extension` to the loop's turn extensions and registers the run tools, and hands `starter` to
// the scheduler. Every route needs a session and validates its body; every control is audited.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GOAL_STATUSES,
  createRunSchema,
  extendBudgetSchema,
  idSchema,
  runControlSchema,
  setGoalSchema,
  updateGoalSchema,
  updatePlanSchema,
  NovaError,
  type EventEnvelope,
} from '@nova/shared';
import {
  RunService,
  runActivity,
  type AuditSink,
  type DeliveryCheck,
  type Notifier,
  type RunServiceOptions,
  type RunStarter,
  type RunStatusLookup,
  type ThreadPolicySource,
  type ThreadStatusSource,
  type ToolRoot,
  type ToolSourceProvider,
  type TurnExtension,
  type TurnStarter,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface RunsArea extends HubArea {
  service: RunService;
  /** Add to the chat loop's turn extensions: context, budgets and onEnd for run threads. */
  extension: TurnExtension;
  /** For the scheduler (schedule fires), chat escalation and delegation (FR-059). */
  starter: RunStarter;
  /** Blocked run threads and sub-agent threads for the derived status (FR-215). */
  status: ThreadStatusSource;
  /** A run's autonomy as its approval policy; a read-only researcher's profile (docs/09 §10). */
  policy: ThreadPolicySource;
  /** The run tools as one source (they refuse outside their threads). */
  tools: ToolSourceProvider;
  /** Bind the chat loop that runs turns (the ChatService implements TurnStarter). */
  useTurns(starter: TurnStarter): void;
  /** The scheduler's delivery receipts for scheduled `message` outputs (FR-187). */
  useDelivery(check: DeliveryCheck): void;
  /** The shared derived status (the requests area's ThreadStatusService) for RunView.derived. */
  useStatus(fn: RunStatusLookup): void;
  /** The gate's `resetReviewBreaker`, called when the user resumes a run the breaker stopped. */
  useReviewReset(fn: (key: string) => void): void;
  /** Continue runs left running by a restart; call after the chat loop recovered (FR-052). */
  recover(): Promise<number>;
}

export interface RunsDeps {
  audit?: AuditSink;
  notifier?: Notifier;
  /** The roots of a thread, for `file` outputs (FR-187); the tools area's scope. */
  roots?: (accountId: string, threadId: string, projectId: string | null) => Promise<ToolRoot[]>;
  /** Tests: a simulated clock and timers. */
  now?: RunServiceOptions['now'];
  timers?: RunServiceOptions['timers'];
  goalDebounceMs?: number;
}

/** Most activity events read for one run (its thread's trace included). */
const MAX_ACTIVITY_EVENTS = 5000;

const params = z.object({ id: idSchema });
const listQuery = z.object({
  status: z.enum(['active', 'all']).default('active'),
  projectId: idSchema.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const goalsQuery = z.object({ status: z.enum(GOAL_STATUSES).optional() });
const redirectBody = runControlSchema.extend({ text: z.string().trim().min(1).max(8000) });
const emptyBody = z.object({}).passthrough().optional();

export function setupRuns(ctx: HubContext & RunsDeps): Promise<RunsArea> {
  const log = ctx.log.child('runs');
  const service = new RunService({
    db: ctx.db,
    events: ctx.events,
    threads: ctx.threads,
    settings: {
      defaultBudgets: (projectId) => ctx.setting('runs.defaultBudgets', projectId),
      autonomy: (projectId) => ctx.setting('runs.autonomy', projectId),
      subagents: (projectId) => ctx.setting('runs.subagents', projectId),
      escalation: (projectId) => ctx.setting('chat.escalation', projectId),
    },
    ...(ctx.audit ? { audit: ctx.audit } : {}),
    ...(ctx.notifier ? { notifier: ctx.notifier } : {}),
    ...(ctx.roots ? { roots: ctx.roots } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(ctx.timers ? { timers: ctx.timers } : {}),
    ...(ctx.goalDebounceMs !== undefined ? { goalDebounceMs: ctx.goalDebounceMs } : {}),
    dataDir: ctx.dataDir,
    log,
  });
  // A thread waiting for an approval puts its run in `waiting_approval` (docs/09 §9).
  const offStatus = ctx.events.bus.subscribe('thread.status.changed', (e) => {
    const ref = e.payload.ref as { kind?: unknown; id?: unknown } | undefined;
    const status = e.payload.status;
    if (ref?.kind !== 'thread' || typeof ref.id !== 'string' || typeof status !== 'string') return;
    service.onThreadStatus(ref.id, status).catch((err: unknown) => {
      log.warn('could not follow a thread status', { err });
    });
  });
  // The auto-reviewer's breaker interrupts the run until the user resumes it (FR-085).
  const offBreaker = ctx.events.bus.subscribe('review.breaker.tripped', (e) => {
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    service
      .onReviewBreaker({
        runId: str(e.payload.runId) ?? e.correlation?.runId ?? null,
        threadId: str(e.payload.threadId) ?? e.correlation?.threadId ?? null,
      })
      .catch((err: unknown) => {
        log.warn('could not pause a run for the review breaker', { err });
      });
  });

  return Promise.resolve({
    service,
    extension: service.extension,
    starter: service.starter,
    status: service.status,
    policy: service.policy,
    tools: service.toolSource,
    useTurns: (starter) => {
      service.useTurns(starter);
    },
    useDelivery: (check) => {
      service.useDelivery(check);
    },
    useStatus: (fn) => {
      service.useStatus(fn);
    },
    useReviewReset: (fn) => {
      service.useReviewReset(fn);
    },
    recover: () => service.recover(),
    register(app: FastifyInstance) {
      // ---- runs ---------------------------------------------------------------------------
      app.get('/api/v1/runs', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = listQuery.parse(req.query);
        return service.list(accountId, {
          status: q.status,
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: q.limit } : {}),
        });
      });

      app.post('/api/v1/runs', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const body = createRunSchema.parse(req.body);
        // An autonomous run's consequential actions go to the auto-reviewer (FR-085); without a
        // reviewer model each one would be denied, so say so before the run starts.
        const autonomy = body.autonomy ?? (await ctx.setting('runs.autonomy', body.projectId));
        if (autonomy === 'autonomous' && !(await ctx.setting('review.model')))
          throw new NovaError(
            'validation',
            'an autonomous run needs a reviewer model: choose one in Settings → Code',
            { details: { field: 'autonomy', reason: 'review_model_required' } },
          );
        const run = await service.create({
          accountId,
          objective: body.objective,
          ...(body.title ? { title: body.title } : {}),
          projectId: body.projectId ?? null,
          origin: 'user',
          ...(body.autonomy ? { autonomy: body.autonomy } : {}),
          ...(body.budgets ? { budgets: body.budgets } : {}),
          ...(body.expectedOutput ? { expectedOutput: body.expectedOutput } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.goal ? { goal: body.goal } : {}),
          ...(body.template ? { template: body.template } : {}),
          ...(body.attachmentIds?.length ? { attachmentIds: body.attachmentIds } : {}),
          // The signed-in user typed the objective (FR-189); the source becomes `run:<id>`.
          authority: { kind: 'user', source: '' },
          start: true,
        });
        return reply.status(201).send(run);
      });

      app.get('/api/v1/runs/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        return service.get(accountId, id);
      });

      app.post('/api/v1/runs/:id/pause', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        emptyBody.parse(req.body);
        return service.pause(accountId, id);
      });

      app.post('/api/v1/runs/:id/resume', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        emptyBody.parse(req.body);
        return service.resume(accountId, id);
      });

      app.post('/api/v1/runs/:id/start', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        emptyBody.parse(req.body);
        return service.start(accountId, id);
      });

      app.post('/api/v1/runs/:id/cancel', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        emptyBody.parse(req.body);
        return service.cancel(accountId, id);
      });

      app.post('/api/v1/runs/:id/redirect', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = redirectBody.parse(req.body);
        return service.redirect(accountId, id, body.text);
      });

      app.post('/api/v1/runs/:id/budget', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = extendBudgetSchema.parse(req.body);
        return service.extendBudget(accountId, id, body);
      });

      app.put('/api/v1/runs/:id/plan', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = updatePlanSchema.parse(req.body);
        return service.setPlan(accountId, id, body.steps);
      });

      app.get('/api/v1/runs/:id/subagents', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        return { items: await service.subagents(accountId, id) };
      });

      // The run's trace (FR-057): its thread's turns, tool calls, approvals and policy
      // decisions, with the run's plan, status, budget and sub-agent events, oldest first.
      app.get('/api/v1/runs/:id/activity', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const threadId = await service.threadOf(accountId, id);
        const events: EventEnvelope[] = [];
        let after: string | null = null;
        while (events.length < MAX_ACTIVITY_EVENTS) {
          const page = await ctx.events.since(after, 500, { threadId, accountId });
          events.push(...page);
          if (page.length < 500) break;
          after = page.at(-1)!.id;
        }
        return { items: runActivity(events) };
      });

      // ---- goals (FR-181) -----------------------------------------------------------------
      app.get('/api/v1/runs/:id/goal', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        // A run without a goal answers `null` (the web client's getRunGoal).
        const goal = await service.getRunGoal(accountId, id);
        return reply.type('application/json').send(JSON.stringify(goal));
      });

      app.put('/api/v1/runs/:id/goal', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = setGoalSchema.parse(req.body);
        return service.setRunGoal(accountId, id, body);
      });

      app.delete('/api/v1/runs/:id/goal', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        await service.clearRunGoal(accountId, id);
        return { ok: true };
      });

      app.get('/api/v1/goals', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = goalsQuery.parse(req.query);
        return { items: await service.listGoals(accountId, q.status) };
      });

      app.get('/api/v1/goals/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        return service.getGoal(accountId, id);
      });

      app.patch('/api/v1/goals/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const body = updateGoalSchema.parse(req.body);
        return service.updateGoal(accountId, id, body);
      });

      for (const action of ['pause', 'resume', 'complete'] as const) {
        app.post(`/api/v1/goals/:id/${action}`, async (req) => {
          const accountId = await ctx.accountOf(req);
          const { id } = params.parse(req.params);
          emptyBody.parse(req.body);
          return service.goalAction(accountId, id, action);
        });
      }
    },
    close: async () => {
      offStatus();
      offBreaker();
      await service.close();
    },
  });
}
