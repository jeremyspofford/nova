// Memory consolidation and the history-reference toggle (FR-204, FR-205; contracts/hub-api.md
// "Memory & import"). Builds the ConsolidationService, schedules it every 15 minutes, wires the
// `memory.referencePastChats` setting into memory, and serves the summary, runs and topic
// routes. Every route requires a session and validates its input with zod.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idSchema, memoryTopicSchema } from '@nova/shared';
import { CONSOLIDATION_INTERVAL_MS, ConsolidationService, type MemoryService } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ConsolidationArea extends HubArea {
  service: ConsolidationService;
}

export interface ConsolidationOptions {
  /** How often the background job looks for work (default 15 minutes). */
  intervalMs?: number;
}

const SCOPE_KINDS = ['global', 'project'] as const;

const summaryQuerySchema = z.object({
  scopeKind: z.enum(SCOPE_KINDS).optional(),
  /** The contract's `scope=` filter; same as scopeKind. */
  scope: z.enum(SCOPE_KINDS).optional(),
  scopeRef: idSchema.optional(),
});

const consolidateBodySchema = z
  .object({
    scopeKind: z.enum(SCOPE_KINDS).optional(),
    scopeRef: idSchema.optional(),
  })
  .strict();

export async function setupConsolidation(
  ctx: HubContext & { memory: MemoryService },
  opts: ConsolidationOptions = {},
): Promise<ConsolidationArea> {
  const log = ctx.log.child('consolidation');
  // FR-205: the toggle is read per turn, so turning it off stops use at once.
  ctx.memory.configure({
    referencePastChats: (projectId) => ctx.setting('memory.referencePastChats', projectId),
  });
  const service = new ConsolidationService({
    db: ctx.db,
    events: ctx.events,
    memory: ctx.memory,
    router: ctx.router,
    model: (accountId) => ctx.threads.defaultModel(accountId),
    settings: () => ctx.setting('memory.consolidation'),
    log,
  });
  const recovered = await service.recover();
  if (recovered) log.info('marked interrupted consolidation runs as failed', { recovered });

  const timer = setInterval(() => {
    service.tick().catch((err: unknown) => log.warn('memory consolidation pass failed', { err }));
  }, opts.intervalMs ?? CONSOLIDATION_INTERVAL_MS);
  timer.unref();

  ctx.diagnostics.add('memoryConsolidation', async () => {
    const owner = ctx.db.raw.prepare('SELECT id FROM account ORDER BY created_at LIMIT 1').get() as
      { id: string } | undefined;
    const last = owner ? service.runs(owner.id, 1)[0] : undefined;
    return {
      settings: await ctx.setting('memory.consolidation'),
      referencePastChats: await ctx.setting('memory.referencePastChats'),
      lastRun: last ? { phase: last.phase, status: last.status, endedAt: last.endedAt } : null,
    };
  });

  return {
    service,
    register(app: FastifyInstance) {
      const { accountOf } = ctx;

      app.get('/api/v1/memory/summary', async (req) => {
        const accountId = await accountOf(req);
        const q = summaryQuerySchema.parse(req.query);
        return service.summary(accountId, {
          scopeKind: q.scopeKind ?? q.scope,
          scopeRef: q.scopeRef,
        });
      });

      app.post('/api/v1/memory/consolidate', async (req, reply) => {
        const accountId = await accountOf(req);
        const body = consolidateBodySchema.parse(req.body ?? {});
        const run = await service.start(accountId, body);
        void reply.status(202);
        return run;
      });

      app.get('/api/v1/memory/consolidations', async (req) => {
        const accountId = await accountOf(req);
        return { items: service.runs(accountId) };
      });

      app.get('/api/v1/memory/topics', async (req) => {
        const accountId = await accountOf(req);
        return { items: service.topics(accountId) };
      });

      app.patch('/api/v1/memory/topics', async (req) => {
        const accountId = await accountOf(req);
        return service.setTopic(accountId, memoryTopicSchema.parse(req.body));
      });
    },
    async close() {
      clearInterval(timer);
      await service.stop();
    },
  };
}
