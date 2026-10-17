// M6 channels, event triggers, MCP event subscriptions and notification routing (migration
// 0021_channels.sql; docs/06 `channel_binding`, `trigger`, `mcp_event_subscription`,
// `mcp_event_delivery`; FR-088, FR-056, FR-201, FR-060). SQL migrations are authoritative;
// test/schema.test.ts checks them. `agent_id` is plain TEXT (the agents area owns `agent`), and
// history rows keep run and thread ids as plain TEXT.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { project, thread } from './chat.ts';
import { account } from './core.ts';
import { mcpServer } from './mcp.ts';
import { schedule } from './schedules.ts';

const CHANNEL_KINDS = ['inapp', 'slack', 'teams', 'telegram', 'email', 'webhook', 'voice'] as const;
const AUDIENCES = ['private', 'shared'] as const;

/** One external conversation bound to one thread of an agent (ADR-070). */
export const channelBinding = sqliteTable(
  'channel_binding',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    agentId: text('agent_id'),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    label: text('label').notNull(),
    externalRef: text('external_ref').notNull(),
    audience: text('audience', { enum: AUDIENCES }).notNull().default('shared'),
    threadId: text('thread_id').references(() => thread.id, { onDelete: 'set null' }),
    sharePrimaryThread: integer('share_primary_thread', { mode: 'boolean' })
      .notNull()
      .default(false),
    allowUnknown: integer('allow_unknown', { mode: 'boolean' }).notNull().default(false),
    /** JSON settings without secrets. */
    configJson: text('config_json'),
    /** `secret://channel/<owner binding id>`: the prefix of the binding's secrets. */
    secretRef: text('secret_ref'),
    ratePerMinute: integer('rate_per_minute').notNull().default(10),
    ratePerHour: integer('rate_per_hour').notNull().default(120),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    statusDetail: text('status_detail'),
    lastMessageAt: text('last_message_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_channel_binding_account').on(t.accountId, t.kind, t.createdAt),
    index('idx_channel_binding_thread').on(t.threadId),
    index('idx_channel_binding_agent').on(t.agentId),
  ],
);

/** External users mapped to a Nova identity and permission scope. */
export const channelIdentity = sqliteTable(
  'channel_identity',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('member'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('channel_identity_unique').on(t.accountId, t.kind, t.externalId)],
);

/** Messages in and out of a binding: dedupe, loop prevention and rate caps (hash only). */
export const channelMessage = sqliteTable(
  'channel_message',
  {
    id: text('id').primaryKey(),
    bindingId: text('binding_id')
      .notNull()
      .references(() => channelBinding.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    externalId: text('external_id'),
    conversation: text('conversation'),
    threadRef: text('thread_ref'),
    sender: text('sender'),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    status: text('status').notNull(),
    reason: text('reason'),
    textHash: text('text_hash'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uq_channel_message_external').on(t.bindingId, t.direction, t.externalId),
    index('idx_channel_message_window').on(t.bindingId, t.direction, t.createdAt),
  ],
);

/** Event triggers (FR-056, docs/09 §7). */
export const trigger = sqliteTable(
  'trigger',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scheduleId: text('schedule_id').references(() => schedule.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    agentId: text('agent_id'),
    projectId: text('project_id').references(() => project.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: ['webhook', 'connector_event', 'mcp_event', 'fs_change', 'email', 'schedule'],
    }).notNull(),
    title: text('title').notNull(),
    action: text('action', { enum: ['run', 'wake'] })
      .notNull()
      .default('run'),
    instructions: text('instructions').notNull(),
    sourceRef: text('source_ref'),
    configJson: text('config_json'),
    dedupeKey: text('dedupe_key'),
    secretRef: text('secret_ref'),
    autonomy: text('autonomy', { enum: ['ask_first', 'standard'] })
      .notNull()
      .default('standard'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastFiredAt: text('last_fired_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_trigger_account').on(t.accountId, t.createdAt),
    index('idx_trigger_source').on(t.kind, t.sourceRef),
  ],
);

/** Each event a trigger saw, by dedupe key. */
export const triggerEvent = sqliteTable(
  'trigger_event',
  {
    triggerId: text('trigger_id')
      .notNull()
      .references(() => trigger.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    accountId: text('account_id').notNull(),
    status: text('status', { enum: ['started', 'failed', 'skipped'] }).notNull(),
    runId: text('run_id'),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    detail: text('detail'),
    receivedAt: text('received_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.triggerId, t.dedupeKey] }),
    index('idx_trigger_event_received').on(t.triggerId, t.receivedAt),
  ],
);

/** MCP event subscriptions (FR-201); the id is the webhook path segment. */
export const mcpEventSubscription = sqliteTable(
  'mcp_event_subscription',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    mcpServerId: text('mcp_server_id')
      .notNull()
      .references(() => mcpServer.id, { onDelete: 'cascade' }),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => trigger.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(),
    remoteRef: text('remote_ref'),
    webhookSecretRef: text('webhook_secret_ref').notNull(),
    filterJson: text('filter_json'),
    expiresAt: text('expires_at'),
    refreshBefore: text('refresh_before'),
    status: text('status', {
      enum: ['pending', 'active', 'refreshing', 'lapsed', 'failed', 'removed'],
    })
      .notNull()
      .default('pending'),
    lastDeliveryAt: text('last_delivery_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_mcp_event_subscription_refresh').on(t.refreshBefore),
    index('idx_mcp_event_subscription_trigger').on(t.triggerId),
  ],
);

/** Accepted, signed deliveries (≤ 256 KiB), deduped by id; kept 7 days. */
export const mcpEventDelivery = sqliteTable(
  'mcp_event_delivery',
  {
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => mcpEventSubscription.id, { onDelete: 'cascade' }),
    deliveryId: text('delivery_id').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    runId: text('run_id'),
    receivedAt: text('received_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subscriptionId, t.deliveryId] }),
    index('idx_mcp_event_delivery_received').on(t.receivedAt),
  ],
);

/** Notification routing per category (FR-060). */
export const notificationRule = sqliteTable(
  'notification_rule',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    category: text('category', {
      enum: ['approval', 'completion', 'error', 'attention', 'system'],
    }).notNull(),
    inapp: integer('inapp', { mode: 'boolean' }).notNull().default(true),
    os: integer('os', { mode: 'boolean' }).notNull().default(true),
    /** JSON array of channel binding ids. */
    channelsJson: text('channels_json').notNull().default('[]'),
    bypassQuiet: integer('bypass_quiet', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.category] })],
);

/** Quiet hours (FR-060): a daily window in a time zone. */
export const quietHours = sqliteTable('quiet_hours', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => account.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  timezone: text('timezone').notNull(),
  /** JSON array of weekdays (0 = Sunday) a window starts on. */
  daysJson: text('days_json').notNull().default('[0,1,2,3,4,5,6]'),
  updatedAt: text('updated_at').notNull(),
});

/** Channel copies of notifications; deferred ones wait for the end of quiet hours. */
export const notificationDelivery = sqliteTable(
  'notification_delivery',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    notificationId: text('notification_id'),
    bindingId: text('binding_id')
      .notNull()
      .references(() => channelBinding.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    dueAt: text('due_at').notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    receipt: text('receipt'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    sentAt: text('sent_at'),
  },
  (t) => [index('idx_notification_delivery_due').on(t.dueAt)],
);
