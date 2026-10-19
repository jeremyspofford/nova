// M7 sync tables (migration 0033_sync.sql; FR-109, FR-112, FR-129, ADR-010). SQL migrations are
// authoritative; test/schema.test.ts checks them.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';

const KINDS = [
  'thread',
  'message',
  'project',
  'memory',
  'space',
  'page',
  'schedule',
  'setting',
] as const;

/** The Hub's clock (`hlc`), change-feed cursor (`cursor`) and sweep progress. */
export const syncMeta = sqliteTable('sync_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** The current value and clock of every synced field: the change feed. */
export const syncField = sqliteTable(
  'sync_field',
  {
    kind: text('kind', { enum: KINDS }).notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    /** The thread of a message. */
    parentId: text('parent_id'),
    valueJson: text('value_json').notNull(),
    hlc: text('hlc').notNull(),
    /** The device whose op set it; null for a change made on the Hub. */
    deviceId: text('device_id'),
    cursor: integer('cursor').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.entityId, t.field] }),
    uniqueIndex('idx_sync_field_cursor').on(t.cursor),
    index('idx_sync_field_account').on(t.accountId, t.cursor),
    index('idx_sync_field_parent').on(t.kind, t.parentId),
  ],
);

/** Values a last-writer-wins merge overwrote, for restore. */
export const syncMergeEntry = sqliteTable(
  'sync_merge_entry',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: KINDS }).notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    reason: text('reason', { enum: ['concurrent', 'stale', 'restore'] }).notNull(),
    lostValueJson: text('lost_value_json').notNull(),
    lostHlc: text('lost_hlc').notNull(),
    lostDeviceId: text('lost_device_id'),
    winnerValueJson: text('winner_value_json').notNull(),
    winnerHlc: text('winner_hlc').notNull(),
    winnerDeviceId: text('winner_device_id'),
    status: text('status', { enum: ['open', 'restored'] })
      .notNull()
      .default('open'),
    restoredAt: text('restored_at'),
    restoredHlc: text('restored_hlc'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_sync_merge_account').on(t.accountId, t.createdAt),
    index('idx_sync_merge_entity').on(t.kind, t.entityId),
  ],
);

/** A device's replica and its sync progress. */
export const syncReplica = sqliteTable(
  'sync_replica',
  {
    deviceId: text('device_id')
      .primaryKey()
      .references(() => device.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    cursor: integer('cursor').notNull().default(0),
    lastPullAt: text('last_pull_at'),
    lastPushAt: text('last_push_at'),
    lastError: text('last_error'),
    lastErrorAt: text('last_error_at'),
    resetAt: text('reset_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_sync_replica_account').on(t.accountId)],
);

/** The first answer to a request with an `Idempotency-Key` (FR-112), kept 24 hours. */
export const idempotencyKey = sqliteTable(
  'idempotency_key',
  {
    principal: text('principal').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    accountId: text('account_id'),
    bodyHash: text('body_hash').notNull(),
    /** Null while the first request runs. */
    status: integer('status'),
    response: text('response'),
    contentType: text('content_type'),
    replayable: integer('replayable', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.principal, t.key, t.method, t.path] }),
    index('idx_idempotency_key_expires').on(t.expiresAt),
  ],
);
