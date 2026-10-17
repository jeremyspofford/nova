// Channels area (FR-088, FR-056, FR-201, FR-060; docs/13 §4, docs/09 §7): channel bindings and
// identity mapping, event triggers, MCP event subscriptions and notification routing with quiet
// hours. Every route needs a session and validates its body, except the three public inbound
// endpoints, which authenticate by signature or token and read the raw body:
//   POST /api/v1/channels/:id/inbound          (Slack signing secret, Teams JWT, webhook token)
//   POST /api/v1/triggers/:id/webhook          (per-trigger token and signature)
//   POST /api/v1/mcp/events/:subscriptionId    (MCP delivery signature, ≤ 256 KiB)
// What it needs from other areas is bound late (`useTurns`, `useRuns`, `useApprovals`,
// `useRequests`, `useAgents`, `useMcp`); what it offers them: `sender` (ChannelSender), `tools`
// (channel.list, channel.send), `delivery` (Slack and Teams for the scheduler), `quietHours`
// and `removeForAgent`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  channelIdentitySchema,
  channelTestSchema,
  createChannelBindingSchema,
  createMcpSubscriptionSchema,
  createTriggerSchema,
  idSchema,
  notificationCategorySchema,
  notificationRuleSchema,
  quietHoursSchema,
  updateChannelBindingSchema,
  updateTriggerSchema,
} from '@nova/shared';
import {
  BotFrameworkVerifier,
  ChannelService,
  EmailAdapter,
  InAppAdapter,
  McpEventService,
  NotificationRouter,
  SlackAdapter,
  TeamsAdapter,
  TriggerService,
  WebhookAdapter,
  channelDelivery,
  channelToolSource,
  channelTools,
  type ApprovalRequests,
  type AuditSink,
  type BindingThreadResolver,
  type ChannelInboundGuard,
  type ChannelSender,
  type DeliveryChannel,
  type McpEventSource,
  type PrivateOriginCheck,
  type RequestBroker,
  type RunStarter,
  type SubscriptionTimers,
  type TeamsTokenVerifier,
  type ToolSourceProvider,
  type TurnStarter,
  type WebhookTransport,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ChannelsArea extends HubArea {
  service: ChannelService;
  triggers: TriggerService;
  mcpEvents: McpEventService;
  routing: NotificationRouter;
  /** Where agents' turns reply to a bound thread (ChannelSender). */
  sender: ChannelSender;
  /** `channel.list` and `channel.send`, offered in agent threads and bound threads. */
  tools: ToolSourceProvider;
  /** Slack and Teams as schedule delivery targets: `schedules.useChannel(kind, channel)`. */
  delivery: { slack: DeliveryChannel; teams: DeliveryChannel };
  /** The quiet window containing `at`, or null (the agents area's `QuietHours`, FR-060). */
  quietHours(accountId: string, at: Date): Promise<{ start: string; end: string } | null>;
  /** Remove an agent's bindings and triggers (call before deleting the agent, FR-090). */
  removeForAgent(accountId: string, agentId: string): Promise<void>;
  /** The chat loop: channel turns and wakes. */
  useTurns(starter: TurnStarter): void;
  /** The runs area's RunStarter: triggers that start runs. */
  useRuns(runs: RunStarter): void;
  /** The policy area's approvals flow, for approvals answered from a channel. */
  useApprovals(approvals: ApprovalRequests): void;
  /** The requests area's broker: asks the owner before private content goes to a shared channel. */
  useRequests(broker: RequestBroker): void;
  /** The agents area: a binding's thread, private-origin content and an agent's wake thread. */
  useAgents(agents: {
    threadFor?: BindingThreadResolver;
    originOf?: PrivateOriginCheck;
    agentThread?: (accountId: string, agentId: string) => Promise<string>;
    /** The external-agent rule (FR-194): ExternalAgentGuard. */
    externalAgents?: ChannelInboundGuard;
  }): void;
  /** The MCP client's event calls (@nova/mcp McpEventsClient over the connection manager). */
  useMcp(source: McpEventSource): void;
}

export interface ChannelsDeps {
  audit?: AuditSink;
  /** Tests: a clock and timers, mock service endpoints and a webhook transport. */
  now?: () => Date;
  timers?: SubscriptionTimers;
  slackApiBase?: string;
  teamsVerifier?: TeamsTokenVerifier;
  teamsOpenIdUrl?: string;
  teamsTokenUrl?: string;
  teamsServiceHost?: (host: string, protocol: string) => boolean;
  webhookTransport?: WebhookTransport;
}

const params = z.object({ id: idSchema });
const categoryParams = z.object({ category: notificationCategorySchema });
const listQuery = z.object({ agentId: idSchema.optional() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const emptyBody = z.object({}).strict().optional();
/** The parser limit of the public endpoints; the MCP receiver refuses more than 256 KiB itself. */
const RAW_LIMIT = 1024 * 1024;

export function setupChannels(ctx: HubContext, deps: ChannelsDeps = {}): Promise<ChannelsArea> {
  const log = ctx.log.child('channels');
  const now = deps.now ?? (() => new Date());
  const createThread = async (
    accountId: string,
    input: { title: string; mode: 'chat' | 'agent' },
  ) => (await ctx.threads.create(accountId, { title: input.title, mode: input.mode })).id;
  const audit = deps.audit;
  const service = new ChannelService({
    db: ctx.db,
    events: ctx.events,
    secrets: ctx.secrets,
    setting: ctx.setting,
    log,
    now,
    createThread,
    ...(audit ? { audit } : {}),
    adapters: (credentials) => ({
      slack: new SlackAdapter({
        credentials,
        now,
        ...(deps.slackApiBase ? { apiBase: deps.slackApiBase } : {}),
      }),
      teams: new TeamsAdapter({
        credentials,
        now,
        verifier:
          deps.teamsVerifier ??
          new BotFrameworkVerifier({
            now,
            ...(deps.teamsOpenIdUrl ? { openIdUrl: deps.teamsOpenIdUrl } : {}),
          }),
        ...(deps.teamsTokenUrl ? { tokenUrl: deps.teamsTokenUrl } : {}),
        ...(deps.teamsServiceHost ? { serviceHost: deps.teamsServiceHost } : {}),
      }),
      webhook: new WebhookAdapter({
        credentials,
        now,
        ...(deps.webhookTransport ? { transport: deps.webhookTransport } : {}),
      }),
      email: new EmailAdapter(),
      inapp: new InAppAdapter({ now }),
    }),
  });
  const triggers = new TriggerService({
    db: ctx.db,
    events: ctx.events,
    secrets: ctx.secrets,
    setting: ctx.setting,
    log,
    now,
    createThread,
    ...(audit ? { audit } : {}),
  });
  const webhookBase = async (): Promise<string> => {
    const configured = await ctx.setting('channels.publicUrl');
    if (configured) return configured;
    const origin = ctx.config.allowedOrigins[0];
    if (origin) return origin;
    const host =
      ctx.config.host === '0.0.0.0' || ctx.config.host === '::' ? '127.0.0.1' : ctx.config.host;
    return `${ctx.config.tls ? 'https' : 'http'}://${host}:${ctx.config.port}`;
  };
  const mcpEvents = new McpEventService({
    db: ctx.db,
    events: ctx.events,
    secrets: ctx.secrets,
    webhookBase,
    log,
    now,
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(audit ? { audit } : {}),
  });
  const routing = new NotificationRouter({
    db: ctx.db,
    log,
    now,
    timers: deps.timers ?? realTimers(),
    ...(audit ? { audit } : {}),
  });
  triggers.useSubscriptions(mcpEvents);
  mcpEvents.useTriggers((accountId, triggerId, e) => triggers.fire(accountId, triggerId, e));
  service.useConnectorEvents(triggers.onConnectorMessage);
  routing.useSender(service);
  mcpEvents.start();
  routing.start();

  // Approvals a channel turn waits for go to its conversation; notifications to the channels the
  // rules name (FR-060).
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const offApproval = ctx.events.bus.subscribe('approval.requested', (e) => {
    const approvalId = str(e.payload.approvalId);
    if (!e.accountId || !approvalId) return;
    service
      .onApprovalRequested({
        accountId: e.accountId,
        threadId: e.correlation?.threadId ?? null,
        turnId: e.correlation?.turnId ?? null,
        approvalId,
      })
      .catch((err: unknown) => log.warn('approval not delivered to the channel', { err }));
  });
  const offNotification = ctx.events.bus.subscribe('notification.created', (e) => {
    const notificationId = str(e.payload.notificationId);
    const kind = str(e.payload.kind);
    if (!e.accountId || !notificationId || !kind) return;
    routing
      .onNotification({
        accountId: e.accountId,
        notificationId,
        kind: notificationCategorySchema.parse(kind),
        title: str(e.payload.title) ?? 'Notification',
      })
      .catch((err: unknown) => log.warn('notification routing failed', { err }));
  });

  ctx.diagnostics.add('channels', () => {
    const count = (sql: string) => (ctx.db.raw.prepare(sql).get() as { n: number }).n;
    return Promise.resolve({
      bindings: count('SELECT count(*) AS n FROM channel_binding'),
      connected: count('SELECT count(*) AS n FROM channel_binding WHERE enabled = 1'),
      triggers: count("SELECT count(*) AS n FROM trigger WHERE kind <> 'schedule'"),
      mcpSubscriptions: count(
        "SELECT count(*) AS n FROM mcp_event_subscription WHERE status <> 'removed'",
      ),
      pendingNotifications: count(
        "SELECT count(*) AS n FROM notification_delivery WHERE status = 'pending'",
      ),
    });
  });

  const tools = channelToolSource(
    channelTools(service),
    (accountId, threadId) => service.bindingsOfThread(accountId, threadId).length > 0,
  );

  function register(app: FastifyInstance): void {
    // ---- channel bindings (FR-088) --------------------------------------------------------
    app.get('/api/v1/channels', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = listQuery.parse(req.query);
      return {
        items: await service.list(accountId, q.agentId ? { agentId: q.agentId } : {}),
        adapters: service.adapterViews(),
      };
    });

    app.post('/api/v1/channels', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = createChannelBindingSchema.parse(req.body);
      const view = await service.create(accountId, body);
      return reply.status(201).send(view);
    });

    app.get('/api/v1/channels/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.get(accountId, id);
    });

    app.patch('/api/v1/channels/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.update(accountId, id, updateChannelBindingSchema.parse(req.body));
    });

    app.delete('/api/v1/channels/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await service.remove(accountId, id);
      return { ok: true };
    });

    for (const action of ['connect', 'disconnect'] as const) {
      app.post(`/api/v1/channels/:id/${action}`, async (req) => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        emptyBody.parse(req.body);
        return service.setEnabled(accountId, id, action === 'connect');
      });
    }

    app.post('/api/v1/channels/:id/test', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const body = channelTestSchema.parse(req.body ?? {});
      return { receipt: await service.test(accountId, id, body.text) };
    });

    app.get('/api/v1/channel-identities', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.listIdentities(accountId) };
    });

    app.post('/api/v1/channel-identities', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = channelIdentitySchema.parse(req.body);
      const view = await service.addIdentity(accountId, {
        kind: body.kind,
        externalId: body.externalId,
        role: body.role,
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
      return reply.status(201).send(view);
    });

    app.delete('/api/v1/channel-identities/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await service.removeIdentity(accountId, id);
      return { ok: true };
    });

    // ---- event triggers (FR-056) ----------------------------------------------------------
    app.get('/api/v1/triggers', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: triggers.list(accountId) };
    });

    app.post('/api/v1/triggers', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const view = await triggers.create(accountId, createTriggerSchema.parse(req.body));
      return reply.status(201).send(view);
    });

    app.get('/api/v1/triggers/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return triggers.get(accountId, id);
    });

    app.patch('/api/v1/triggers/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return triggers.update(accountId, id, updateTriggerSchema.parse(req.body));
    });

    app.delete('/api/v1/triggers/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await triggers.remove(accountId, id);
      return { ok: true };
    });

    app.get('/api/v1/triggers/:id/events', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const { limit } = historyQuery.parse(req.query);
      return { items: triggers.history(accountId, id, limit) };
    });

    // ---- MCP event subscriptions (FR-201) -------------------------------------------------
    app.get('/api/v1/mcp/subscriptions', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: mcpEvents.list(accountId) };
    });

    app.post('/api/v1/mcp/subscriptions', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = createMcpSubscriptionSchema.parse(req.body);
      const trigger = await triggers.create(accountId, { ...body, kind: 'mcp_event' });
      return reply.status(201).send(trigger.subscription);
    });

    app.get('/api/v1/mcp/subscriptions/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return mcpEvents.get(accountId, id);
    });

    app.delete('/api/v1/mcp/subscriptions/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return mcpEvents.remove(accountId, id);
    });

    app.get('/api/v1/mcp/event-sources', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: mcpEvents.sources(accountId) };
    });

    // ---- notification routing and quiet hours (FR-060) ------------------------------------
    app.get('/api/v1/notification-rules', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: routing.rules(accountId), quietHours: routing.quietHoursView(accountId) };
    });

    app.put('/api/v1/notification-rules/:category', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { category } = categoryParams.parse(req.params);
      return routing.setRule(accountId, category, notificationRuleSchema.parse(req.body));
    });

    app.delete('/api/v1/notification-rules/:category', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { category } = categoryParams.parse(req.params);
      return routing.resetRule(accountId, category);
    });

    app.get('/api/v1/quiet-hours', async (req) => {
      const accountId = await ctx.accountOf(req);
      return routing.quietHoursView(accountId);
    });

    app.put('/api/v1/quiet-hours', async (req) => {
      const accountId = await ctx.accountOf(req);
      return routing.setQuietHours(accountId, quietHoursSchema.parse(req.body));
    });

    // ---- public inbound endpoints: raw bodies, authenticated by signature or token --------
    void app.register((scoped, _opts, done) => {
      scoped.removeAllContentTypeParsers();
      scoped.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: RAW_LIMIT },
        (_req: FastifyRequest, body: Buffer, next: (err: Error | null, body?: Buffer) => void) =>
          next(null, body),
      );
      const raw = (req: FastifyRequest) => ({
        headers: req.headers,
        rawBody: new Uint8Array(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)),
      });

      scoped.post('/api/v1/channels/:id/inbound', async (req) => {
        const { id } = params.parse(req.params);
        const out = await service.receive(id, raw(req));
        return out.reply ?? { ok: true, status: out.status };
      });

      scoped.post('/api/v1/triggers/:id/webhook', async (req, reply: FastifyReply) => {
        const { id } = params.parse(req.params);
        const out = await triggers.receiveWebhook(id, raw(req));
        return reply.status(out.status === 'started' ? 202 : 200).send({
          ok: out.status !== 'failed',
          status: out.status,
          ...(out.reason ? { reason: out.reason } : {}),
          ...(out.runId ? { runId: out.runId } : {}),
        });
      });

      scoped.post('/api/v1/mcp/events/:subscriptionId', async (req, reply: FastifyReply) => {
        const { subscriptionId } = z.object({ subscriptionId: idSchema }).parse(req.params);
        const out = await mcpEvents.receive(subscriptionId, raw(req));
        return reply.status(out.status).send(out.body);
      });
      done();
    });
  }

  return Promise.resolve({
    service,
    triggers,
    mcpEvents,
    routing,
    sender: service,
    tools,
    delivery: {
      slack: channelDelivery(service, 'slack'),
      teams: channelDelivery(service, 'teams'),
    },
    quietHours: (accountId, at) => routing.quietWindowAt(accountId, at),
    removeForAgent: async (accountId, agentId) => {
      await triggers.removeForAgent(accountId, agentId);
      await service.removeForAgent(accountId, agentId);
    },
    useTurns: (starter) => {
      service.useTurns(starter);
      triggers.useTurns(starter);
    },
    useRuns: (runs) => triggers.useRuns(runs),
    useApprovals: (approvals) => service.useApprovals(approvals),
    useRequests: (broker) => {
      service.useShareAsk(async (input) => {
        const minutes = await ctx.setting('policy.approvalTimeoutMinutes');
        const n = input.sources.length;
        const r = await broker.ask(
          {
            accountId: input.accountId,
            kind: 'user_input',
            correlation: { threadId: input.threadId },
            payload: {
              question:
                `A reply in ${input.label}, a shared channel, uses private information ` +
                `(${n} ${n === 1 ? 'source' : 'sources'}). Share it there?`,
              choices: ['Share', 'Do not share'],
              allowFreeText: false,
            },
            timeoutMs: minutes * 60_000,
          },
          AbortSignal.timeout(minutes * 60_000 + 60_000),
        );
        return r.status === 'resolved' &&
          (r.result as { choice?: unknown } | null)?.choice === 'Share'
          ? 'allow'
          : 'deny';
      });
    },
    useAgents: (agents) => {
      if (agents.threadFor) service.useThreads(agents.threadFor);
      if (agents.originOf) service.usePrivacy(agents.originOf);
      if (agents.agentThread) triggers.useAgentThreads(agents.agentThread);
      if (agents.externalAgents) service.useInboundGuard(agents.externalAgents);
    },
    useMcp: (source) => mcpEvents.useSource(source),
    register,
    close: async () => {
      offApproval();
      offNotification();
      await mcpEvents.stop();
      await routing.stop();
      await service.close();
    },
  });
}

function realTimers(): SubscriptionTimers {
  return {
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  };
}
