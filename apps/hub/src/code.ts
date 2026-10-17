// Code sessions in the Hub (FR-061, FR-063..FR-066, FR-069, FR-073, FR-074, FR-211;
// contracts/hub-api.md "Code, tools, extensions"). The area owns the CodeService and its routes,
// and exports the runtime seams the loop and the gate consume: `policy` (ThreadPolicySource),
// `extension` (TurnExtension), `tools` (the coding tools, a ToolSourceProvider) and `status`
// (ThreadStatusSource). Changes are refreshed when a turn ends, when the diff is read and after
// every tool call on a code thread that may have written files (tool.call.completed), so a
// change carries the call that made it. The mode last used in a folder is saved in the
// `code.folderModes` setting.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SETTINGS,
  commitSchema,
  createCodeSessionSchema,
  diffCommentsSchema,
  hunkDecisionSchema,
  idSchema,
  isNovaError,
  updateCodeSessionSchema,
  type PermissionMode,
} from '@nova/shared';
import {
  CodeService,
  codeToolSource,
  noopAudit,
  type AuditSink,
  type SandboxClient,
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
  /** A Code session's permission mode as approval policy, profile and roots (gate, tool scope). */
  policy: ThreadPolicySource;
  /** The Environment block and the change refresh for each turn of a code thread. */
  extension: TurnExtension;
  /** git.status, git.diff, git.log, test.run, code.symbols, code.refs (source `builtin`). */
  tools: ToolSourceProvider;
  /** Blocked when the environment is down or the folder is gone (FR-215). */
  status: ThreadStatusSource;
  /** Comments submitted to the agent start a turn (FR-065). */
  useTurns(starter: TurnStarter): void;
  /** Terminals in the session folder (FR-066). */
  useTerminals(terminals: TerminalManager): void;
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
}

/** Tools that never write files: no refresh after them. */
const READ_ONLY_TOOLS =
  /^(fs\.(read|list|search)|git\.(status|diff|log)|code\.(symbols|refs)|web\.\w+|tool\.search|artifact\.\w+|context\.\w+)$/;
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

export function setupCode(ctx: HubContext & CodeDeps): Promise<CodeArea> {
  const log = ctx.log.child('code');
  const service = new CodeService({
    db: ctx.db,
    events: ctx.events,
    audit: ctx.audit ?? noopAudit,
    threads: ctx.threads,
    router: ctx.router,
    dataDir: ctx.dataDir,
    setting: ctx.setting,
    rememberMode: (accountId, folder, mode) => rememberMode(ctx, accountId, folder, mode),
    sandbox: () => ctx.sandbox?.() ?? null,
    ...(ctx.home !== undefined ? { home: ctx.home } : {}),
    log,
  });
  if (ctx.terminals) service.useTerminals(ctx.terminals);
  if (ctx.turns) service.useTurns(ctx.turns);
  const tools = codeToolSource(service);

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
  const sweeper = setInterval(
    () => {
      service
        .sweepArchived()
        .catch((err: unknown) => log.warn('code session sweep failed', { err }));
    },
    ctx.sweepIntervalMs ?? 5 * 60_000,
  );
  sweeper.unref();

  return Promise.resolve({
    service,
    policy: service.policy,
    extension: service.extension,
    tools,
    status: service.status,
    useTurns: (starter) => service.useTurns(starter),
    useTerminals: (terminals) => service.useTerminals(terminals),
    register(app: FastifyInstance) {
      // ---- environments (FR-062) ---------------------------------------------------------
      app.get('/api/v1/environments', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await service.environments(accountId) };
      });

      // ---- sessions (FR-061, FR-063) -----------------------------------------------------
      app.get('/api/v1/code/sessions', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = listQuery.parse(req.query);
        return { items: await service.list(accountId, { archived: q.archived === 'true' }) };
      });

      app.post('/api/v1/code/sessions', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const view = await service.create(accountId, createCodeSessionSchema.parse(req.body));
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
      clearInterval(sweeper);
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
