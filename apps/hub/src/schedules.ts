// Schedules area (FR-055, FR-187, ADR-079; contracts/hub-api.md "schedules"): the routes over the
// ScheduleService, its loop and the `schedule.report` tool. Schedules fire Work runs through the
// runs area's RunStarter, wired late with `useRuns` (which also starts the loop). Only the user
// creates schedules from the API (origin `user`); agent-made schedules and self-set wakes are M6.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scheduleSchema, updateScheduleSchema, type ScheduleFireView } from '@nova/shared';
import {
  ScheduleService,
  type DeliveryChannel,
  type DeliveryKind,
  type Notifier,
  type ReceiptNotifier,
  type RunStarter,
  type ScheduleAuditSink,
  type SchedulePatch,
  type SchedulerTimers,
  type ToolSourceProvider,
  type WebhookTransport,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface SchedulesArea extends HubArea {
  service: ScheduleService;
  /** `schedule.report` for the chat loop's tool sources (offered while a scheduled run is open). */
  reportTools: ToolSourceProvider;
  /** The runs area's RunStarter; starts the loop. */
  useRuns(runs: RunStarter): void;
  /** In-app and OS delivery (the ops area's NotificationService gives receipts). */
  useNotifier(notifier: Notifier | ReceiptNotifier): void;
  useAudit(audit: ScheduleAuditSink): void;
  /** M6 channels add slack, teams and email delivery. */
  useChannel(kind: DeliveryKind, channel: DeliveryChannel): void;
  /** For the runs area: verify a scheduled run's `message` output by delivering it (FR-187). */
  verifyMessageOutput(
    accountId: string,
    runId: string,
    finalReply: string | null,
  ): Promise<{ verified: boolean; evidence: string }>;
}

export interface SchedulesDeps {
  audit?: ScheduleAuditSink;
  notifier?: Notifier | ReceiptNotifier;
  runs?: RunStarter;
  /** Tests: a simulated clock and timers, and a webhook transport without the network. */
  now?: () => Date;
  timers?: SchedulerTimers;
  webhookTransport?: WebhookTransport;
}

const params = z.object({ id: z.string().min(1).max(100) });
const firesQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

export function setupSchedules(ctx: HubContext, deps: SchedulesDeps = {}): Promise<SchedulesArea> {
  const service = new ScheduleService({
    db: ctx.db,
    events: ctx.events,
    secrets: ctx.secrets,
    log: ctx.log.child('schedules'),
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.webhookTransport ? { webhookTransport: deps.webhookTransport } : {}),
  });
  const useRuns = (runs: RunStarter) => {
    service.useRuns(runs);
    void service.start();
  };
  if (deps.runs) useRuns(deps.runs);

  ctx.diagnostics.add('schedules', () => {
    const row = ctx.db.raw
      .prepare(
        `SELECT count(*) AS total, sum(enabled) AS enabled, min(CASE WHEN enabled = 1
           THEN next_run_at END) AS next FROM schedule`,
      )
      .get() as { total: number; enabled: number | null; next: string | null };
    return Promise.resolve({ total: row.total, enabled: row.enabled ?? 0, nextRunAt: row.next });
  });

  function register(app: FastifyInstance): void {
    app.get('/api/v1/schedules', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.list(accountId) };
    });

    app.post('/api/v1/schedules', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      // The strict schema has no `origin`: the API creates only the user's own schedules.
      const body = scheduleSchema.parse(req.body);
      const view = await service.create(accountId, body);
      void reply.status(201);
      return view;
    });

    app.patch('/api/v1/schedules/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const parsed = updateScheduleSchema.parse(req.body);
      // Only the fields the client sent: the partial schema still fills defaults
      // (deliveryTargets), which must not overwrite the stored ones.
      const sent = new Set(Object.keys(req.body ?? {}));
      const patch = Object.fromEntries(
        Object.entries(parsed).filter(([k]) => sent.has(k)),
      ) as SchedulePatch;
      return service.update(accountId, id, patch);
    });

    app.delete('/api/v1/schedules/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await service.remove(accountId, id);
      return { ok: true };
    });

    app.get('/api/v1/schedules/:id/fires', async (req): Promise<{ items: ScheduleFireView[] }> => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const { limit } = firesQuery.parse(req.query);
      return { items: await service.history(accountId, id, limit) };
    });

    app.post('/api/v1/schedules/:id/run', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const out = await service.runNow(accountId, id);
      void reply.status(201);
      return out;
    });
  }

  return Promise.resolve({
    service,
    reportTools: service.reportTools,
    useRuns,
    useNotifier: (n) => service.useNotifier(n),
    useAudit: (a) => service.useAudit(a),
    useChannel: (kind, channel) => service.useChannel(kind, channel),
    verifyMessageOutput: (accountId, runId, finalReply) =>
      service.verifyMessageOutput(accountId, runId, finalReply),
    register,
    close: () => service.stop(),
  });
}
