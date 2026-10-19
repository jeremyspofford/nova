// M7 channels: poller cursors, signed approval links and push (migration 0035_channels_m7.sql;
// FR-110, FR-111, FR-060; docs/13 §4-§6). SQL migrations are authoritative; test/schema.test.ts
// checks them. Secrets (the link key, VAPID key, Web Push auth secrets) live in the secret store;
// rows hold only references. Device, notification and approval ids are plain TEXT.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { channelBinding } from './channels.ts';
import { account } from './core.ts';

/** Where a poller left off for a credential group (Telegram offset, IMAP UIDVALIDITY and UID). */
export const channelCursor = sqliteTable('channel_cursor', {
  bindingId: text('binding_id')
    .primaryKey()
    .references(() => channelBinding.id, { onDelete: 'cascade' }),
  cursor: text('cursor').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Signed one-use approval links sent by email (the row makes each single use). */
export const channelApprovalLink = sqliteTable(
  'channel_approval_link',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    bindingId: text('binding_id')
      .notNull()
      .references(() => channelBinding.id, { onDelete: 'cascade' }),
    approvalId: text('approval_id').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    decision: text('decision'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_channel_approval_link_approval').on(t.approvalId)],
);

/** Web Push subscriptions; the auth secret is in the vault under `authRef`. */
export const pushSubscription = sqliteTable(
  'push_subscription',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id'),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    authRef: text('auth_ref').notNull(),
    label: text('label'),
    status: text('status', { enum: ['active', 'failing', 'gone'] })
      .notNull()
      .default('active'),
    failures: integer('failures').notNull().default(0),
    expiresAt: text('expires_at'),
    lastSuccessAt: text('last_success_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('push_subscription_endpoint').on(t.accountId, t.endpoint)],
);

/** Each push sent: where it went and how it ended, never what it said (kept 7 days). */
export const pushDelivery = sqliteTable(
  'push_delivery',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    notificationId: text('notification_id'),
    targetKind: text('target_kind', { enum: ['webpush', 'relay'] }).notNull(),
    targetRef: text('target_ref'),
    status: text('status', { enum: ['sent', 'failed', 'gone', 'skipped'] }).notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_push_delivery_created').on(t.accountId, t.createdAt)],
);
