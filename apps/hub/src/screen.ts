// The screen area (FR-093, FR-207, FR-098, FR-087, FR-075; docs/11 §4.2, §5, §6): computer use
// on an agent's computer through the screen service, its tools, and the routes the clients use to
// see and control it: status and the control indicator, the enablement toggle, the kill key,
// grants, recorded actions with before/after screenshots, takeover with a live view over a
// WebSocket whose handshake needs a session, and appshots. Computers, the thread-to-computer
// mapping, pausing the agent and asking the user are bound late by the areas that own them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  appshotCreateSchema,
  appshotsQuerySchema,
  idSchema,
  isNovaError,
  screenActionsQuerySchema,
  screenControlSchema,
  screenGrantSchema,
  screenGrantsQuerySchema,
  screenInputSchema,
  takeoverBrowserInputSchema,
  takeoverInputSchema,
  takeoverStartSchema,
} from '@nova/shared';
import {
  ScreenService,
  screenToolSource,
  screenTools,
  type ArtifactService,
  type AuditSink,
  type ComputerProvider,
  type RequestBroker,
  type ScreenComputerRef,
  type ScreenControlHooks,
  type TakeoverInput,
  type ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ScreenArea extends HubArea {
  service: ScreenService;
  /** The computer-use tools; the tools area lists this source last (docs/11 §5.3). */
  tools: ToolSourceProvider;
  /** Where computers come from (the computers area). */
  useComputers(provider: ComputerProvider): void;
  /** The computer an agent's thread works on (the agents area). */
  useComputerOf(
    resolver: (accountId: string, threadId: string) => Promise<ScreenComputerRef | null>,
  ): void;
  /** Pause and resume the agent of a computer on takeover and the kill key (agents, runs). */
  useAgentControl(hooks: ScreenControlHooks): void;
  /** Asks the user for `screen.request_access` (the requests area). */
  useRequests(broker: RequestBroker): void;
}

export interface ScreenDeps {
  audit?: AuditSink;
  computers?: ComputerProvider;
  artifacts?: ArtifactService;
  now?: () => Date;
  /** The live view's frame interval: one screenshot per 2 s by default (docs/11 §8). */
  liveIntervalMs?: number;
  /** How often screenshots past the retention are dropped; default daily. */
  pruneIntervalMs?: number;
  observeIntervalMs?: number;
}

const params = z.object({ id: idSchema });
const grantParams = z.object({ id: idSchema, grantId: idSchema });
const shotParams = z.object({
  id: idSchema,
  actionId: idSchema,
  which: z.enum(['before', 'after']),
});
const surfaceQuery = z.object({ surface: z.enum(['desktop', 'browser']).default('desktop') });
const liveFrame = z.union([
  z.object({ type: z.literal('input'), action: screenInputSchema }).strict(),
  z.object({ type: z.literal('input'), browser: takeoverBrowserInputSchema }).strict(),
  z.object({ type: z.literal('kill') }).strict(),
  z.object({ type: z.literal('refresh') }).strict(),
]);

const DAY_MS = 86_400_000;

export async function setupScreen(ctx: HubContext & ScreenDeps): Promise<ScreenArea> {
  const log = ctx.log.child('screen');
  let computerOf:
    ((accountId: string, threadId: string) => Promise<ScreenComputerRef | null>) | null = null;
  let broker: RequestBroker | null = null;
  const service = new ScreenService({
    db: ctx.db,
    events: ctx.events,
    dataDir: ctx.dataDir,
    log,
    computers: ctx.computers ?? null,
    ...(ctx.audit ? { audit: ctx.audit } : {}),
    ...(ctx.artifacts ? { artifacts: ctx.artifacts } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(ctx.observeIntervalMs !== undefined ? { observeIntervalMs: ctx.observeIntervalMs } : {}),
    settings: {
      grantMinutes: () => ctx.setting('screen.grantMinutes'),
      killKey: () => ctx.setting('screen.killKey'),
      tierOverrides: () => ctx.setting('screen.tierOverrides'),
    },
  });
  const tools = screenToolSource(
    screenTools({
      service,
      computerOf: () => computerOf,
      broker: () => broker,
      grantMinutes: () => ctx.setting('screen.grantMinutes'),
      killKey: () => ctx.setting('screen.killKey'),
    }),
    { computerOf: () => computerOf },
  );
  // A takeover cannot outlive the process that served it.
  try {
    const closed = await service.recover();
    if (closed) log.info('closed takeovers left open by a restart', { count: closed });
  } catch (err) {
    log.warn('could not close takeovers left open by a restart', { err });
  }
  const prune = () => {
    void ctx
      .setting('screen.screenshotRetentionDays')
      .then((days) => service.pruneScreenshots(days))
      .catch((err: unknown) => log.warn('screenshot pruning failed', { err }));
  };
  prune();
  const pruner = setInterval(prune, ctx.pruneIntervalMs ?? DAY_MS);
  pruner.unref();
  const liveMs = ctx.liveIntervalMs ?? 2_000;
  const sockets = new Set<() => void>();
  const socketAccounts = new WeakMap<FastifyRequest, string>();

  return {
    service,
    tools,
    useComputers: (provider) => service.useComputers(provider),
    useComputerOf: (resolver) => {
      computerOf = resolver;
    },
    useAgentControl: (hooks) => service.useControl(hooks),
    useRequests: (b) => {
      broker = b;
    },

    register(app: FastifyInstance): void {
      const base = '/api/v1/computers/:id';

      // ---- status, enablement, kill key -------------------------------------------------
      app.get(`${base}/screen`, async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.status(accountId, params.parse(req.params).id);
      });

      app.put(`${base}/screen/control`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const { enabled } = screenControlSchema.parse(req.body);
        return service.setEnabled(accountId, params.parse(req.params).id, enabled);
      });

      app.post(`${base}/screen/kill`, async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.kill(accountId, params.parse(req.params).id, 'user');
      });

      app.post(`${base}/screen/resume`, async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.resumeControl(accountId, params.parse(req.params).id);
      });

      // ---- the user's view --------------------------------------------------------------
      app.get(`${base}/screen/observation`, async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.frame(accountId, params.parse(req.params).id);
      });

      app.get(`${base}/screen/frame`, async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        const { surface } = surfaceQuery.parse(req.query);
        const png =
          surface === 'browser'
            ? await service.browserFrame(accountId, id)
            : Buffer.from((await service.frame(accountId, id)).image, 'base64');
        return reply
          .header('Content-Type', 'image/png')
          .header('Cache-Control', 'no-store')
          .send(Buffer.from(png));
      });

      // ---- grants -----------------------------------------------------------------------
      app.get(`${base}/screen/grants`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = screenGrantsQuerySchema.parse(req.query);
        const all = q.all === 'true' || q.all === '1';
        return { items: await service.listGrants(accountId, params.parse(req.params).id, all) };
      });

      app.post(`${base}/screen/grants`, async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const body = screenGrantSchema.parse(req.body);
        const view = await service.grant(accountId, params.parse(req.params).id, body);
        void reply.status(201);
        return view;
      });

      app.post(`${base}/screen/grants/:grantId/renew`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = grantParams.parse(req.params);
        return service.renewGrant(accountId, p.id, p.grantId);
      });

      app.delete(`${base}/screen/grants/:grantId`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = grantParams.parse(req.params);
        return service.revokeGrant(accountId, p.id, p.grantId);
      });

      // ---- recorded actions (FR-098) ----------------------------------------------------
      app.get(`${base}/screen/actions`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = screenActionsQuerySchema.parse(req.query);
        return { items: await service.listActions(accountId, params.parse(req.params).id, q) };
      });

      app.get(`${base}/screen/actions/:actionId/:which`, async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const p = shotParams.parse(req.params);
        const png = await service.actionScreenshot(accountId, p.id, p.actionId, p.which);
        return reply
          .header('Content-Type', 'image/png')
          .header('Cache-Control', 'private, max-age=3600')
          .send(png);
      });

      // ---- takeover (FR-087) ------------------------------------------------------------
      app.get(`${base}/takeover`, async (req) => {
        const accountId = await ctx.accountOf(req);
        return { takeover: await service.takeover(accountId, params.parse(req.params).id) };
      });

      app.post(`${base}/takeover`, async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { surface } = takeoverStartSchema.parse(req.body ?? {});
        const view = await service.startTakeover(accountId, params.parse(req.params).id, surface);
        void reply.status(201);
        return view;
      });

      app.post(`${base}/takeover/input`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const body = takeoverInputSchema.parse(req.body);
        return service.takeoverInput(accountId, params.parse(req.params).id, body);
      });

      app.post(`${base}/takeover/end`, async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.endTakeover(accountId, params.parse(req.params).id);
      });

      // The live view: frames every `liveMs`, the control state on every change, and the
      // user's input and kill key while the socket is open.
      app.get(
        `${base}/screen/live`,
        {
          websocket: true,
          // The session (and the computer's owner) is checked before the upgrade.
          preValidation: async (req: FastifyRequest) => {
            const accountId = await ctx.accountOf(req);
            await service.status(accountId, params.parse(req.params).id);
            socketAccounts.set(req, accountId);
          },
        },
        (socket, req) => {
          const accountId = socketAccounts.get(req);
          const p = params.safeParse(req.params);
          const q = surfaceQuery.safeParse(req.query);
          if (!accountId || !p.success || !q.success) {
            socket.close(4400, 'validation');
            return;
          }
          const id = p.data.id;
          const surface = q.data.surface;
          let open = true;
          let busy = false;
          const send = (frame: Record<string, unknown>) => {
            if (open && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
          };
          const fail = (err: unknown) =>
            send({
              type: 'error',
              error: isNovaError(err)
                ? { code: err.code, message: err.message }
                : { code: 'server_error', message: 'the screen could not be read' },
            });
          const frame = async () => {
            if (busy || !open) return;
            busy = true;
            try {
              if (surface === 'browser') {
                const png = await service.browserFrame(accountId, id);
                send({
                  type: 'frame',
                  surface,
                  mime: 'image/png',
                  image: Buffer.from(png).toString('base64'),
                  takenAt: new Date().toISOString(),
                });
              } else send({ type: 'frame', surface, ...(await service.frame(accountId, id)) });
            } catch (err) {
              fail(err);
            } finally {
              busy = false;
            }
          };
          const state = () =>
            service.status(accountId, id).then(
              (status) => send({ type: 'state', status }),
              (err: unknown) => fail(err),
            );
          void state().then(frame);
          const timer = setInterval(() => void frame(), liveMs);
          timer.unref();
          const off = service.onChange((a, c) => {
            if (a === accountId && c === id) void state();
          });
          const stop = () => {
            open = false;
            clearInterval(timer);
            off();
          };
          sockets.add(stop);
          socket.on('message', (raw: Buffer) => {
            let msg: z.infer<typeof liveFrame>;
            try {
              msg = liveFrame.parse(JSON.parse(raw.toString('utf8')));
            } catch {
              send({ type: 'error', error: { code: 'validation', message: 'unknown live frame' } });
              return;
            }
            if (msg.type === 'refresh') void frame();
            else if (msg.type === 'kill') void service.kill(accountId, id, 'user').catch(fail);
            else {
              const input: TakeoverInput =
                'action' in msg ? { action: msg.action } : { browser: msg.browser };
              void service
                .takeoverInput(accountId, id, input)
                .then((r) => {
                  send({ type: 'input.ack', ...r });
                  return frame();
                })
                .catch(fail);
            }
          });
          socket.on('close', () => {
            stop();
            sockets.delete(stop);
          });
        },
      );

      // ---- appshots (FR-075) ------------------------------------------------------------
      app.post(`${base}/appshots`, async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const body = appshotCreateSchema.parse(req.body ?? {});
        const view = await service.appshot({
          accountId,
          computerId: params.parse(req.params).id,
          source: body.source,
          windowId: body.windowId,
          app: body.app,
          threadId: body.threadId ?? null,
          actor: 'user',
        });
        void reply.status(201);
        return view;
      });

      app.get('/api/v1/appshots', async (req) => {
        const accountId = await ctx.accountOf(req);
        return {
          items: await service.listAppshots(accountId, appshotsQuerySchema.parse(req.query)),
        };
      });

      app.get('/api/v1/appshots/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        return service.getAppshot(accountId, params.parse(req.params).id);
      });
    },

    close() {
      clearInterval(pruner);
      for (const stop of sockets) stop();
      sockets.clear();
      return Promise.resolve();
    },
  };
}
