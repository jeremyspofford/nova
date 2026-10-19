// M7.5 device operations (migration 0044_device_ops.sql; ADR-096 D9; FR-126, FR-150): novad
// decommissions and compute-node policy. SQL migrations are authoritative; test/schema.test.ts
// checks them. The Hub's client certificate for the management channel lives in the vault.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';
import { approval } from './policy.ts';

/** One decommission of a novad device; at most one open per device. */
export const deviceDecommission = sqliteTable(
  'device_decommission',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    purge: integer('purge', { mode: 'boolean' }).notNull().default(false),
    status: text('status', {
      enum: ['awaiting_approval', 'running', 'done', 'denied', 'expired', 'cancelled', 'failed'],
    }).notNull(),
    approvalId: text('approval_id').references(() => approval.id),
    changeId: text('change_id'),
    deviceResult: text('device_result', { enum: ['wiped', 'unreachable', 'refused', 'not_told'] }),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('idx_device_decommission_device').on(t.deviceId, t.createdAt),
    index('idx_device_decommission_approval').on(t.approvalId),
    uniqueIndex('idx_device_decommission_open')
      .on(t.deviceId)
      .where(sql`status IN ('awaiting_approval', 'running')`),
  ],
);

/** The owner's policy for a compute node: quiet hours and routing eligibility. */
export const nodePolicy = sqliteTable('node_policy', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => device.id),
  /** JSON list of `HH:MM-HH:MM`. */
  quietHours: text('quiet_hours').notNull().default('[]'),
  timeZone: text('time_zone'),
  routingEligible: integer('routing_eligible', { mode: 'boolean' }).notNull().default(true),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});
