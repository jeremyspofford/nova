// Channels area (FR-088, FR-110, FR-056, FR-201, FR-060, FR-055; docs/13 §4, docs/09 §7): channel
// bindings and identity mapping, event triggers, MCP event subscriptions and notification routing
// with quiet hours. Since M7: Telegram (webhook or long polling) and email (IMAP and SMTP)
// bindings run by the pollers, approval buttons, the message log, the MCP subscription refresh, a
// test notification, the OS/push leg (`usePush`) and a schedule's webhook secret rotated and shown
// once. Every route needs a session and validates its body, except the public endpoints, which
// authenticate another way and read the raw body:
//   POST /api/v1/channels/:id/inbound          (Slack signing secret, Teams JWT, webhook token,
//                                               Telegram secret-token header)
//   POST /api/v1/triggers/:id/webhook          (per-trigger token and signature)
//   POST /api/v1/mcp/events/:subscriptionId    (MCP delivery signature, ≤ 256 KiB)
//   GET/POST /api/v1/channels/approval-links/:token (a signed one-use approval link; GET changes
//                                               nothing, POST answers once)
// What it needs from other areas is bound late (`useTurns`, `useRuns`, `useApprovals`,
// `useRequests`, `useAgents`, `useMcp`); what it offers them: `sender` (ChannelSender), `tools`
// (channel.list, channel.send), `delivery` (Slack and Teams for the scheduler), `quietHours`
// and `removeForAgent`.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  channelIdentityM7Schema,
  channelMessagesQuery,
  channelUpdateConfirmSchema,
  channelTestSchema,
  createChannelBindingM7Schema,
  createMcpSubscriptionSchema,
  httpStatusFor,
  isNovaError,
  notificationTestSchema,
  uuidv7,
  type NotificationTestView,
  type WebhookSecretView,
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
  ChannelPollers,
  ChannelService,
  EmailAdapter,
  InAppAdapter,
  McpEventService,
  NotificationRouter,
  SlackAdapter,
  TeamsAdapter,
  TelegramAdapter,
  TriggerService,
  WebhookAdapter,
  channelDelivery,
  channelToolSource,
  channelTools,
  isHubOwner,
  pinnedPublicAddress,
  webhookSecretRef,
  type ApprovalRequests,
  type AuditSink,
  type BindingThreadResolver,
  type ChannelInboundGuard,
  type ChannelPollersOptions,
  type ChannelSender,
  type DeliveryChannel,
  type McpEventSource,
  type MailReader,
  type Notifier,
  type PrivateOriginCheck,
  type PushLeg,
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
  /** Telegram long polling and email mailboxes (M7). */
  pollers: ChannelPollers;
  /** Where agents' turns reply to a bound thread (ChannelSender). */
  sender: ChannelSender;
  /** `channel.list` and `channel.send`, offered in agent threads and bound threads. */
  tools: ToolSourceProvider;
  /** Slack, Teams and email as schedule delivery targets: `schedules.useChannel(kind, channel)`. */
  delivery: { slack: DeliveryChannel; teams: DeliveryChannel; email: DeliveryChannel };
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
  /** The push area's OS leg (FR-111): pushes what may be raised on the OS now. */
  usePush(push: PushLeg | null): void;
  /** The ops area's notifier, for the test notification route. */
  useNotifier(notifier: Notifier): void;
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
  /** A Telegram-compatible Bot API (a test double); Telegram's own otherwise. */
  telegramApiBase?: string;
  /** Tests: the mailbox reader, and how the pollers wait and back off. */
  mailReader?: MailReader;
  pollers?: Pick<ChannelPollersOptions, 'telegramWaitSeconds' | 'idleMs' | 'backoffMs'>;
}

const params = z.object({ id: idSchema });
const categoryParams = z.object({ category: notificationCategorySchema });
const listQuery = z.object({ agentId: idSchema.optional() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const emptyBody = z.object({}).strict().optional();
const linkParams = z.object({ token: z.string().min(1).max(200) });
const linkAnswer = z
  .object({ decision: z.enum(['allow_once', 'allow_session', 'deny_continue', 'deny_stop']) })
  .strict();
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
  const webhookBase = async (): Promise<string> => {
    const configured = await ctx.setting('channels.publicUrl');
    if (configured) return configured;
    const origin = ctx.config.allowedOrigins[0];
    if (origin) return origin;
    const host =
      ctx.config.host === '0.0.0.0' || ctx.config.host === '::' ? '127.0.0.1' : ctx.config.host;
    return `${ctx.config.tls ? 'https' : 'http'}://${host}:${ctx.config.port}`;
  };
  const service = new ChannelService({
    db: ctx.db,
    events: ctx.events,
    secrets: ctx.secrets,
    setting: ctx.setting,
    log,
    now,
    createThread,
    dataDir: ctx.dataDir,
    publicBase: webhookBase,
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
      telegram: new TelegramAdapter({
        credentials,
        now,
        webhookUrl: async (id) =>
          `${(await webhookBase()).replace(/\/+$/, '')}/api/v1/channels/${id}/inbound`,
        ...(deps.telegramApiBase ? { apiBase: deps.telegramApiBase } : {}),
      }),
      email: new EmailAdapter({
        credentials,
        now,
        log,
        ...(deps.mailReader ? { reader: deps.mailReader } : {}),
        // A non-owner's mailbox servers are public addresses only, pinned (decision 5).
        pinHost: async (bindingId, host) => {
          const row = ctx.db.raw
            .prepare('SELECT account_id FROM channel_binding WHERE id = ?')
            .get(bindingId) as { account_id: string } | undefined;
          if (!row || isHubOwner(ctx.db, row.account_id)) return null;
          return pinnedPublicAddress(host);
        },
      }),
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
  const pollers = new ChannelPollers({
    service,
    db: ctx.db,
    setting: ctx.setting,
    log,
    now,
    ...deps.pollers,
  });
  let notifier: Notifier | null = null;
  mcpEvents.start();
  routing.start();
  pollers.start();

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
        // `os` says whether it may be raised on the OS now (rule and quiet hours at creation).
        os: e.payload.os !== false,
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
      pollers: pollers.groups().length,
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
      const body = createChannelBindingM7Schema.parse(req.body);
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
      // `confirmSenderCheckNone` rides along with the M6 fields (turning email's check off).
      const { confirmSenderCheckNone, ...rest } = z
        .record(z.string(), z.unknown())
        .parse(req.body ?? {});
      const confirm = channelUpdateConfirmSchema.parse(
        confirmSenderCheckNone === undefined ? {} : { confirmSenderCheckNone },
      );
      return service.update(accountId, id, updateChannelBindingSchema.parse(rest), {
        confirmSenderCheckNone: confirm.confirmSenderCheckNone === true,
      });
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

    // The message log (no content: the text is in the thread), paged by `nextCursor` (M7).
    app.get('/api/v1/channels/:id/messages', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.messagesPage(accountId, id, channelMessagesQuery.parse(req.query));
    });

    app.get('/api/v1/channel-identities', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.listIdentities(accountId) };
    });

    app.post('/api/v1/channel-identities', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = channelIdentityM7Schema.parse(req.body);
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

    app.post('/api/v1/mcp/subscriptions/:id/refresh', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      emptyBody.parse(req.body);
      return mcpEvents.refreshNow(accountId, id);
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

    // A test notification of a category through the whole pipeline (in-app, OS and push, channels).
    app.post(
      '/api/v1/notification-rules/:category/test',
      async (req): Promise<NotificationTestView> => {
        const accountId = await ctx.accountOf(req);
        const { category } = categoryParams.parse(req.params);
        const body = notificationTestSchema.parse(req.body ?? {});
        if (!notifier) throw new NovaError('capability_missing', 'notifications are not available');
        const decision = routing.route(accountId, category);
        await notifier.notify({
          accountId,
          kind: category,
          title: body.title ?? 'Test notification',
          body: 'Sent from Settings to check where this category goes.',
          href: '/settings/notifications',
          dedupeKey: `test:${uuidv7()}`,
        });
        await audit?.append({
          accountId,
          actor: 'user',
          kind: 'settings',
          action: 'notification.test',
          resource: `notification_rule:${category}`,
          detail: { os: decision.os, channels: decision.channels.length },
        });
        return { category, ...decision };
      },
    );

    // FR-055: a schedule's webhook signing secret, rotated and shown once (never readable again).
    app.post(
      '/api/v1/schedules/:id/webhook-secret',
      async (req, reply): Promise<WebhookSecretView> => {
        const accountId = await ctx.accountOf(req);
        const { id } = params.parse(req.params);
        emptyBody.parse(req.body);
        const row = ctx.db.raw
          .prepare('SELECT delivery_targets_json FROM schedule WHERE id = ? AND account_id = ?')
          .get(id, accountId) as { delivery_targets_json: string } | undefined;
        if (!row) throw new NovaError('not_found', 'schedule not found');
        let targets: unknown;
        try {
          targets = JSON.parse(row.delivery_targets_json);
        } catch {
          targets = [];
        }
        const hasWebhook =
          Array.isArray(targets) &&
          targets.some((t) => (t as { kind?: unknown } | null)?.kind === 'webhook');
        if (!hasWebhook)
          throw new NovaError('conflict', 'this schedule delivers to no webhook', {
            details: { field: 'targets' },
          });
        const secret = randomBytes(32).toString('hex');
        await ctx.secrets.put(webhookSecretRef(id), secret);
        const rotatedAt = now().toISOString();
        await audit?.append({
          accountId,
          actor: 'user',
          kind: 'schedule',
          action: 'schedule.webhook_secret.rotate',
          resource: `schedule:${id}`,
        });
        void reply.header('cache-control', 'no-store');
        return { scheduleId: id, secret, scheme: 'hmac-sha256', rotatedAt };
      },
    );

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

      // Signed approval links from approval emails: the token is the credential (HMAC with the
      // Hub's link key, one use, short-lived). GET only shows the choices (mail scanners follow
      // links); the page's form POSTs the answer.
      scoped.get('/api/v1/channels/approval-links/:token', async (req, reply: FastifyReply) => {
        const { token } = linkParams.parse(req.params);
        try {
          const view = await service.approvalLinkView(token);
          return page(reply, 200, linkPage(view));
        } catch (err) {
          return page(reply, errorStatus(err), messagePage(errorText(err)));
        }
      });

      scoped.post('/api/v1/channels/approval-links/:token', async (req, reply: FastifyReply) => {
        const { token } = linkParams.parse(req.params);
        try {
          const body = linkAnswer.parse(formOrJson(raw(req).rawBody));
          const out = await service.answerByLink(token, body.decision);
          return page(reply, 200, messagePage(out.text));
        } catch (err) {
          return page(reply, errorStatus(err), messagePage(errorText(err)));
        }
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
    pollers,
    delivery: {
      slack: channelDelivery(service, 'slack'),
      teams: channelDelivery(service, 'teams'),
      email: channelDelivery(service, 'email'),
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
    usePush: (push) => routing.usePush(push),
    useNotifier: (n) => {
      notifier = n;
    },
    register,
    close: async () => {
      offApproval();
      offNotification();
      await pollers.stop();
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

// ---- the approval link page (plain HTML, no scripts, nothing from outside) ----------------------

const DECISION_LABEL: Record<string, string> = {
  allow_once: 'Allow once',
  allow_session: 'Allow for this session',
  deny_continue: 'Deny',
  deny_stop: 'Deny and stop',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Nova approval</title>' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}' +
    'button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}' +
    '@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>' +
    `<body>${body}</body></html>`
  );
}

function linkPage(v: {
  action: string;
  reason: string | null;
  label: string;
  options: string[];
  expiresAt: string;
}): string {
  const buttons = v.options
    .map(
      (o) =>
        `<button type="submit" name="decision" value="${esc(o)}">${esc(DECISION_LABEL[o] ?? o)}</button>`,
    )
    .join('');
  return shell(
    `<h1>Approval needed</h1><p><strong>${esc(v.action)}</strong></p>` +
      (v.reason ? `<p>${esc(v.reason)}</p>` : '') +
      `<p>From ${esc(v.label)}. This link works once, until ${esc(v.expiresAt)}.</p>` +
      `<form method="post">${buttons}</form>`,
  );
}

function messagePage(text: string): string {
  return shell(`<h1>Nova</h1><p>${esc(text)}</p>`);
}

function page(reply: FastifyReply, status: number, html: string): FastifyReply {
  // The token is in the URL: no referrer, no caching, no framing, no scripts.
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-frame-options', 'DENY')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    )
    .send(html);
}

function errorStatus(err: unknown): number {
  if (isNovaError(err)) return httpStatusFor(err.code);
  return err instanceof z.ZodError ? 400 : 500;
}

function errorText(err: unknown): string {
  if (isNovaError(err)) return err.message;
  return err instanceof z.ZodError ? 'Choose one of the offered answers.' : 'Something went wrong.';
}

/** A form post (`decision=…`) or a JSON body. */
function formOrJson(raw: Uint8Array): unknown {
  const text = Buffer.from(raw).toString('utf8').trim();
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
