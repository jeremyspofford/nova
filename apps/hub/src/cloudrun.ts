// Cloud runner area (FR-108, FR-071, FR-116; docs/13 §3, docs/10 §12; contracts/rest-api.md §5;
// ADR-095 decision 4). Owner routes under /api/v1/cloud need a session (none is public): the
// runner's registration (URL, the token into the vault), its test and on/off switch, the cloud
// environments with what the runner reports (rebuild, files, snapshots), the runs (leases) with
// their metering and caps, artifacts copied into a thread, and Work runs started on a cloud
// environment. Saved cloud environments are created and removed through /api/v1/environments
// (kind `cloud`), whose EnvironmentService gets this area's `provider`.
//
// The lead wires: `code.service.envs.useCloud(cloudrun.provider)`,
// `code.service.useEnvironmentTransport('cloud', cloudrun.transportFor)`, the thread sandbox pick
// (`code.sandboxForThread(a, t) ?? cloudrun.sandboxForThread(a, t)`), `cloudrun.workPolicy(
// runs.policy)` in place of `runs.policy`, `cloudrun.extension` among the loop's extensions and
// `cloudrun.useRuns(runs.service)`, and `policy.useAgentPolicy(cloudrun.toolRules(
// agents.agentPolicy))` (the Hub's file tools are hidden in cloud threads).
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  cloudFileQuery,
  cloudRunCapsSchema,
  cloudRunsQuery,
  cloudSnapshotSchema,
  collectCloudArtifactSchema,
  idSchema,
  patchRunnerSchema,
  putRunnerSchema,
  startCloudWorkSchema,
  type CloudWorkView,
} from '@nova/shared';
import {
  ArtifactService,
  CloudRunService,
  managedDenied,
  managedRestrictions,
  type AgentRuleSource,
  type AuditSink,
  type CloudRunnerSettingKey,
  type CloudWorkRuns,
  type EnvCloudProvider,
  type EnvironmentTransport,
  type Notifier,
  type RunService,
  type SandboxClient,
  type ThreadPolicySource,
  type TurnExtension,
} from '@nova/core';
import { schema } from '@nova/storage';
import type { HubArea, HubContext } from './hub-context.ts';

export interface CloudRunArea extends HubArea {
  service: CloudRunService;
  /** For `EnvironmentService.useCloud` (kind `cloud`). */
  provider: EnvCloudProvider;
  /** For `CodeService.useEnvironmentTransport('cloud', …)`: Hub-side Git for cloud sessions. */
  transportFor: (accountId: string, environmentId: string) => Promise<EnvironmentTransport | null>;
  /** The sandbox of a Work run's thread bound to a cloud environment (null otherwise). */
  sandboxForThread(accountId: string, threadId: string): SandboxClient | null;
  /** The runs area's policy with the cloud folder as the root of bound Work threads. */
  workPolicy(base: ThreadPolicySource): ThreadPolicySource;
  /** The Environment block of bound Work threads (a turn extension). */
  extension: TurnExtension;
  /**
   * The gate's agent rule source with the Hub's file tools denied (so hidden) in cloud threads:
   * `policy.useAgentPolicy(cloudrun.toolRules(agents.agentPolicy))`.
   */
  toolRules(base: AgentRuleSource | null): AgentRuleSource;
  /** The runs area's service (Work runs on a cloud environment). */
  useRuns(runs: RunService | CloudWorkRuns): void;
}

export interface CloudRunDeps {
  audit?: AuditSink;
  notifier?: Notifier;
  /** Tests point the client at a fake. */
  fetch?: typeof fetch;
  /** Follow the runner's event streams of active runs (default true). */
  watch?: boolean;
  /** How often leases of archived sessions and ended runs are finished (default 5 min). */
  sweepIntervalMs?: number;
}

const idParams = z.object({ id: idSchema });
const restoreBody = z.object({ keepCurrent: z.boolean().optional() }).strict();

/** The runs area's RunService as the create/start pair Work runs on a cloud environment use. */
export function cloudWorkRuns(runs: RunService): CloudWorkRuns {
  return {
    create: async (input) => {
      const run = await runs.create({
        accountId: input.accountId,
        objective: input.objective,
        ...(input.title ? { title: input.title } : {}),
        projectId: input.projectId,
        origin: 'user',
        ...(input.autonomy ? { autonomy: input.autonomy } : {}),
        ...(input.budgets ? { budgets: input.budgets } : {}),
        ...(input.model ? { model: input.model } : {}),
        // The signed-in user typed the objective (FR-189); it waits for its binding first.
        authority: { kind: 'user', source: '' },
        start: false,
      });
      return { id: run.id, threadId: run.threadId };
    },
    start: (accountId, runId) => runs.start(accountId, runId),
  };
}

export function setupCloudRun(ctx: HubContext, deps: CloudRunDeps = {}): Promise<CloudRunArea> {
  const log = ctx.log.child('cloudrun');

  /** Store one global setting; a managed lock wins and the write is refused (docs/14 §1). */
  async function writeSetting(
    accountId: string,
    key: CloudRunnerSettingKey,
    value: unknown,
  ): Promise<void> {
    const parsed: unknown = SETTINGS[key].schema.parse(value);
    const { setting } = schema;
    const where = and(
      eq(setting.key, key),
      eq(setting.scopeKind, 'global'),
      eq(setting.scopeRef, ''),
    );
    const previous = (await ctx.db.orm.select().from(setting).where(where))[0] ?? null;
    const put = async (valueJson: string | null) => {
      await ctx.db.transaction(async () => {
        await ctx.db.orm.delete(setting).where(where);
        if (valueJson !== null)
          await ctx.db.orm.insert(setting).values({
            key,
            scopeKind: 'global',
            scopeRef: '',
            valueJson,
            updatedAt: new Date().toISOString(),
          });
      });
    };
    await put(JSON.stringify(parsed));
    if (JSON.stringify(await ctx.setting(key)) !== JSON.stringify(parsed)) {
      await put(previous?.valueJson ?? null);
      throw new NovaError('policy_denied', `${key} is set by managed policy`, {
        details: { reason: 'managed' },
      });
    }
    await ctx.events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId,
      payload: { key, scope: 'global' },
    });
  }

  const service = new CloudRunService({
    db: ctx.db,
    events: ctx.events,
    secrets: ctx.secrets,
    setting: ctx.setting,
    writeSetting,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    artifacts: new ArtifactService({ db: ctx.db, events: ctx.events, dataDir: ctx.dataDir }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.watch !== undefined ? { watch: deps.watch } : {}),
    log,
  });
  service.start();

  // A Work run that ended frees its lease at once; archived sessions are found by the sweep.
  const offRun = ctx.events.bus.subscribe('run.completed', (e) => {
    const threadId = e.correlation?.threadId;
    if (!threadId || !e.accountId || !service.bindingFor(e.accountId, threadId)) return;
    service
      .finishThread(e.accountId, threadId)
      .catch((err: unknown) => log.warn('finishing a cloud run failed', { err }));
  });
  const sweeper = setInterval(
    () => {
      service.sweep().catch((err: unknown) => log.warn('cloud run sweep failed', { err }));
    },
    deps.sweepIntervalMs ?? 5 * 60_000,
  );
  sweeper.unref();

  ctx.diagnostics.add('cloudRunner', async () => {
    const v = await service.view();
    const rows = ctx.db.raw
      .prepare('SELECT status, count(*) AS n FROM cloud_run GROUP BY status')
      .all() as { status: string; n: number }[];
    return {
      enabled: v.enabled,
      state: v.state,
      detail: v.detail,
      url: v.url,
      version: v.version,
      substrate: v.substrate?.kind ?? null,
      runs: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    };
  });

  function register(app: FastifyInstance): void {
    // ---- the runner ----
    app.get('/api/v1/cloud/runner', async (req) => {
      await ctx.accountOf(req);
      return service.view();
    });
    app.put('/api/v1/cloud/runner', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.configure(accountId, putRunnerSchema.parse(req.body ?? {}));
    });
    app.patch('/api/v1/cloud/runner', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.setEnabled(accountId, patchRunnerSchema.parse(req.body ?? {}).enabled);
    });
    app.post('/api/v1/cloud/runner/test', async (req) => {
      await ctx.accountOf(req);
      const t = await service.test();
      // A reachable runner also drops environments no saved environment refers to any more.
      if (t.ok)
        await service
          .reconcile()
          .catch((err: unknown) => log.warn('runner reconcile failed', { err }));
      return t;
    });
    app.delete('/api/v1/cloud/runner', async (req) => {
      const accountId = await ctx.accountOf(req);
      await service.forget(accountId);
      return { ok: true };
    });

    // ---- environments ----
    app.get('/api/v1/cloud/environments', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.environments(accountId) };
    });
    app.get('/api/v1/cloud/environments/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.environment(accountId, idParams.parse(req.params).id);
    });
    app.post('/api/v1/cloud/environments/:id/rebuild', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const view = await service.rebuild(accountId, idParams.parse(req.params).id);
      void reply.status(202);
      return view;
    });
    app.get('/api/v1/cloud/environments/:id/files', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      return service.file(accountId, id, cloudFileQuery.parse(req.query).path);
    });
    app.get('/api/v1/cloud/environments/:id/snapshots', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.snapshots(accountId, idParams.parse(req.params).id) };
    });
    app.post('/api/v1/cloud/environments/:id/snapshots', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const body = cloudSnapshotSchema.parse(req.body ?? {});
      const view = await service.snapshot(accountId, id, body.label ?? null, 'manual');
      void reply.status(201);
      return view;
    });
    app.post('/api/v1/cloud/snapshots/:id/restore', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const body = restoreBody.parse(req.body ?? {});
      return service.restore(accountId, id, body.keepCurrent === true);
    });
    app.delete('/api/v1/cloud/snapshots/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await service.deleteSnapshot(accountId, idParams.parse(req.params).id);
      return { ok: true };
    });

    // ---- runs (leases) ----
    app.get('/api/v1/cloud/runs', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.runs(accountId, cloudRunsQuery.parse(req.query)) };
    });
    app.get('/api/v1/cloud/runs/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.run(accountId, idParams.parse(req.params).id);
    });
    app.patch('/api/v1/cloud/runs/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      return service.setCaps(accountId, id, cloudRunCapsSchema.parse(req.body ?? {}));
    });
    app.post('/api/v1/cloud/runs/:id/cancel', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.cancel(accountId, idParams.parse(req.params).id);
    });
    app.post('/api/v1/cloud/runs/:id/artifacts', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const body = collectCloudArtifactSchema.parse(req.body ?? {});
      const view = await service.collectArtifact(accountId, id, body);
      void reply.status(201);
      return view;
    });

    // ---- Work runs on a cloud environment ----
    app.post('/api/v1/cloud/work', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = startCloudWorkSchema.parse(req.body ?? {});
      // An autonomous run's consequential actions go to the auto-reviewer (FR-085).
      let autonomy = body.autonomy ?? (await ctx.setting('runs.autonomy', body.projectId));
      // Managed policy first (FR-106): an autonomy it turns off is refused when asked for, and a
      // default it turns off runs as Standard.
      const refused = managedRestrictions(await ctx.setting('managed.restrict')).autonomy(autonomy);
      if (refused && body.autonomy) throw managedDenied(refused, { autonomy });
      if (refused) autonomy = 'standard';
      if (autonomy === 'autonomous' && !(await ctx.setting('review.model')))
        throw new NovaError(
          'validation',
          'an autonomous run needs a reviewer model: choose one in Settings → Code',
          { details: { field: 'autonomy', reason: 'review_model_required' } },
        );
      const r = await service.startWork(accountId, body);
      const view: CloudWorkView = {
        runId: r.runId,
        threadId: r.threadId,
        environmentId: body.environmentId,
        cloudRun: r.cloudRun,
        snapshot: r.snapshot,
      };
      void reply.status(201);
      return view;
    });
  }

  return Promise.resolve({
    service,
    provider: service.provider,
    transportFor: service.transportFor,
    sandboxForThread: (accountId, threadId) => service.sandboxForThread(accountId, threadId),
    workPolicy: (base) => service.workPolicy(base),
    extension: service.extension,
    toolRules: (base) => service.toolRules(base),
    useRuns: (runs) =>
      service.useRuns('start' in runs && 'get' in runs ? cloudWorkRuns(runs) : runs),
    register,
    close: async () => {
      offRun();
      clearInterval(sweeper);
      await service.close();
    },
  });
}
