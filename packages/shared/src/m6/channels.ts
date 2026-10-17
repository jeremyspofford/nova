// M6 channels API shapes (owned by the channels area; the web reads them): channel bindings and
// identity mapping (FR-088, docs/13 §4), event triggers (FR-056, docs/09 §7), MCP event
// subscriptions (FR-201) and notification routing with quiet hours (FR-060). Secrets are
// write-only: requests may carry them, views only say whether one is set.
import { z } from 'zod';
import { NOTIFICATION_KINDS, idSchema, type NotificationKind } from '../api.ts';

// ---- channel bindings (FR-088) -----------------------------------------------------------------

/** The kinds a binding can be created with; email is listed by adapters but not available yet. */
export const CHANNEL_BINDING_KINDS = ['inapp', 'slack', 'teams', 'email', 'webhook'] as const;
export type ChannelBindingKind = (typeof CHANNEL_BINDING_KINDS)[number];

export const CHANNEL_AUDIENCES = ['private', 'shared'] as const;
export type ChannelAudience = (typeof CHANNEL_AUDIENCES)[number];

export const CHANNEL_ROLES = ['owner', 'member'] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export interface ChannelRateLimit {
  perMinute: number;
  perHour: number;
}

export interface ChannelBindingView {
  id: string;
  agentId: string | null;
  kind: ChannelBindingKind;
  label: string;
  /** The external conversation: a Slack channel or DM id, a Teams conversation id, a name. */
  externalRef: string;
  audience: ChannelAudience;
  /** This binding's thread (ADR-070); null until the first message. */
  threadId: string | null;
  /** Private bindings: the owner's DM and in-app share the agent's primary thread. */
  sharePrimaryThread: boolean;
  /** Unknown senders are answered too (otherwise they are ignored). */
  allowUnknown: boolean;
  rateLimit: ChannelRateLimit;
  /** connected: messages flow; disconnected: turned off; not_configured: credentials missing. */
  status: 'connected' | 'disconnected' | 'not_configured';
  statusDetail: string | null;
  /** Adapter settings without secrets (bot user id, team, app id, callback URL). */
  config: Record<string, string | null>;
  /** Which credentials are stored; values are never returned. */
  credentials: { name: string; set: boolean }[];
  /** The binding whose app credentials this one uses, if not its own. */
  sharesCredentialsWith: string | null;
  /** Where the external service posts (public, authenticated by signature or token). */
  inboundPath: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelAdapterView {
  kind: ChannelBindingKind;
  available: boolean;
  detail: string | null;
}

const label = z.string().trim().min(1).max(200);
const externalRef = z.string().trim().min(1).max(300);
const secret = z.string().min(8).max(2000);
const rateLimitSchema = z
  .object({
    perMinute: z.number().int().min(1).max(600),
    perHour: z.number().int().min(1).max(10_000),
  })
  .strict();

const bindingBase = {
  agentId: idSchema.optional(),
  label: label.optional(),
  audience: z.enum(CHANNEL_AUDIENCES).optional(),
  sharePrimaryThread: z.boolean().optional(),
  allowUnknown: z.boolean().optional(),
  rateLimit: rateLimitSchema.optional(),
  enabled: z.boolean().optional(),
};

/** POST /api/v1/channels. Slack and Teams take their own credentials or share another binding's. */
export const createChannelBindingSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...bindingBase,
        kind: z.literal('inapp'),
        externalRef: externalRef.optional(),
      })
      .strict(),
    z
      .object({
        ...bindingBase,
        kind: z.literal('slack'),
        externalRef,
        credentials: z.object({ botToken: secret, signingSecret: secret }).strict().optional(),
        shareCredentialsWith: idSchema.optional(),
        config: z
          .object({
            botUserId: z.string().trim().min(1).max(100).optional(),
            teamId: z.string().trim().min(1).max(100).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...bindingBase,
        kind: z.literal('teams'),
        externalRef,
        credentials: z.object({ appPassword: secret }).strict().optional(),
        shareCredentialsWith: idSchema.optional(),
        config: z
          .object({
            appId: z.string().trim().min(1).max(200),
            serviceUrl: z.string().url().max(500).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...bindingBase,
        kind: z.literal('webhook'),
        externalRef,
        credentials: z
          .object({ token: z.string().min(24).max(500), secret: z.string().min(32).max(500) })
          .strict(),
        config: z
          .object({ callbackUrl: z.string().url().max(2000).optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...bindingBase,
        kind: z.literal('email'),
        externalRef: z.string().trim().email().max(300),
      })
      .strict(),
  ])
  .refine((v) => !v.sharePrimaryThread || v.audience === 'private', {
    message: 'only a private binding can share the primary thread',
    path: ['sharePrimaryThread'],
  });
export type CreateChannelBindingRequest = z.infer<typeof createChannelBindingSchema>;

/** PATCH /api/v1/channels/:id: the fields sent. Credentials are replaced by name. */
export const updateChannelBindingSchema = z
  .object({
    label: label.optional(),
    audience: z.enum(CHANNEL_AUDIENCES).optional(),
    sharePrimaryThread: z.boolean().optional(),
    allowUnknown: z.boolean().optional(),
    rateLimit: rateLimitSchema.optional(),
    credentials: z.record(z.string().min(1).max(50), secret).optional(),
    config: z.record(z.string().min(1).max(50), z.string().max(2000).nullable()).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateChannelBindingRequest = z.infer<typeof updateChannelBindingSchema>;

/** POST /api/v1/channels/:id/test */
export const channelTestSchema = z
  .object({ text: z.string().trim().min(1).max(2000).optional() })
  .strict();

export interface ChannelIdentityView {
  id: string;
  kind: ChannelBindingKind;
  externalId: string;
  displayName: string | null;
  role: ChannelRole;
  createdAt: string;
}

/** POST /api/v1/channel-identities */
export const channelIdentitySchema = z
  .object({
    kind: z.enum(CHANNEL_BINDING_KINDS),
    externalId: z.string().trim().min(1).max(300),
    displayName: z.string().trim().max(200).optional(),
    role: z.enum(CHANNEL_ROLES).default('member'),
  })
  .strict();

// ---- event triggers (FR-056) -------------------------------------------------------------------

export const TRIGGER_KINDS = [
  'webhook',
  'connector_event',
  'mcp_event',
  'fs_change',
  'email',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const TRIGGER_ACTIONS = ['run', 'wake'] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

export const MCP_SUBSCRIPTION_STATUSES = [
  'pending',
  'active',
  'refreshing',
  'lapsed',
  'failed',
  'removed',
] as const;
export type McpSubscriptionStatus = (typeof MCP_SUBSCRIPTION_STATUSES)[number];

export interface McpSubscriptionView {
  id: string;
  triggerId: string;
  serverId: string;
  event: string;
  status: McpSubscriptionStatus;
  filter: Record<string, unknown> | null;
  expiresAt: string | null;
  refreshBefore: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  /** The webhook the server posts to (public, authenticated by signature). */
  webhookPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerView {
  id: string;
  kind: TriggerKind;
  title: string;
  action: TriggerAction;
  agentId: string | null;
  projectId: string | null;
  instructions: string;
  autonomy: 'ask_first' | 'standard';
  enabled: boolean;
  /** False for kinds whose source is not connected yet (fs_change, email). */
  available: boolean;
  unavailableReason: string | null;
  /** The channel binding, device or MCP subscription the events come from. */
  sourceRef: string | null;
  config: Record<string, unknown>;
  /** The payload field holding the event id (default `id`). */
  dedupeKey: string | null;
  /** Webhook triggers: where to POST (public, token and signature). */
  webhookPath: string | null;
  subscription: McpSubscriptionView | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerEventView {
  triggerId: string;
  dedupeKey: string;
  status: 'started' | 'failed' | 'skipped';
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
  detail: string | null;
  receivedAt: string;
}

const triggerBase = {
  title: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().trim().min(1).max(8000),
  action: z.enum(TRIGGER_ACTIONS).default('run'),
  agentId: idSchema.optional(),
  projectId: idSchema.optional(),
  autonomy: z.enum(['ask_first', 'standard']).optional(),
  enabled: z.boolean().optional(),
};
const dedupeKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'a field path such as id or event.id')
  .max(200);
const mcpEventFields = {
  serverId: idSchema,
  event: z.string().trim().min(1).max(200),
  filter: z.record(z.string().max(100), z.unknown()).optional(),
};

/** POST /api/v1/triggers */
export const createTriggerSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...triggerBase,
        kind: z.literal('webhook'),
        credentials: z
          .object({ token: z.string().min(24).max(500), secret: z.string().min(32).max(500) })
          .strict(),
        dedupeKey: dedupeKey.optional(),
      })
      .strict(),
    z
      .object({
        ...triggerBase,
        kind: z.literal('connector_event'),
        /** A Slack binding whose app receives the channel's events. */
        bindingId: idSchema,
        /** The conversation to watch (default: the binding's own). */
        conversation: z.string().trim().min(1).max(300).optional(),
        /** Only messages containing this text (case-insensitive). */
        contains: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    z.object({ ...triggerBase, kind: z.literal('mcp_event'), ...mcpEventFields }).strict(),
    z
      .object({
        ...triggerBase,
        kind: z.literal('fs_change'),
        deviceId: idSchema,
        path: z.string().min(1).max(4000),
      })
      .strict(),
    z
      .object({
        ...triggerBase,
        kind: z.literal('email'),
        mailbox: z.string().trim().min(1).max(300),
        label: z.string().trim().min(1).max(300),
      })
      .strict(),
  ])
  .refine((v) => v.action !== 'wake' || v.agentId !== undefined, {
    message: 'waking needs an agent',
    path: ['agentId'],
  });
export type CreateTriggerRequest = z.infer<typeof createTriggerSchema>;

/** PATCH /api/v1/triggers/:id: the fields sent. */
export const updateTriggerSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    instructions: z.string().trim().min(1).max(8000).optional(),
    enabled: z.boolean().optional(),
    autonomy: z.enum(['ask_first', 'standard']).optional(),
    dedupeKey: dedupeKey.nullable().optional(),
    contains: z.string().trim().min(1).max(500).nullable().optional(),
    credentials: z
      .object({ token: z.string().min(24).max(500), secret: z.string().min(32).max(500) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateTriggerRequest = z.infer<typeof updateTriggerSchema>;

/** POST /api/v1/mcp/subscriptions: an mcp_event trigger and its subscription in one call. */
export const createMcpSubscriptionSchema = z
  .object({ ...triggerBase, ...mcpEventFields })
  .strict()
  .refine((v) => v.action !== 'wake' || v.agentId !== undefined, {
    message: 'waking needs an agent',
    path: ['agentId'],
  });

/** An MCP server's advertised events (FR-201). */
export interface McpEventSourceView {
  serverId: string;
  name: string;
  events: { name: string; description: string | null }[];
}

// ---- notification routing (FR-060) -------------------------------------------------------------

export interface NotificationRuleView {
  category: NotificationKind;
  inapp: boolean;
  os: boolean;
  /** Channel binding ids that receive this category. */
  channels: string[];
  /** Delivered during quiet hours too (approvals by default). */
  bypassQuietHours: boolean;
  /** No rule is stored: the built-in default. */
  isDefault: boolean;
  updatedAt: string | null;
}

/** PUT /api/v1/notification-rules/:category */
export const notificationRuleSchema = z
  .object({
    inapp: z.boolean(),
    os: z.boolean(),
    channels: z.array(idSchema).max(10).default([]),
    bypassQuietHours: z.boolean().default(false),
  })
  .strict();
export type NotificationRuleRequest = z.infer<typeof notificationRuleSchema>;

export const notificationCategorySchema = z.enum(NOTIFICATION_KINDS);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export interface QuietHoursView {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  days: number[];
  /** Quiet hours are in force now. */
  active: boolean;
  /** When the current window ends (null when not active). */
  until: string | null;
}

/** PUT /api/v1/quiet-hours */
export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    start: hhmm,
    end: hhmm,
    timezone: z.string().trim().min(1).max(100),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  })
  .strict()
  .refine((v) => v.start !== v.end, { message: 'start and end must differ', path: ['end'] });
export type QuietHoursRequest = z.infer<typeof quietHoursSchema>;
