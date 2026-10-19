// M7.5 firmware (migration 0040_firmware.sql; FR-146, ADR-096 D4): the Hub's copies of device
// snapshots (values sealed in a file, never in a row) and firmware changes with their approval.
// SQL migrations are authoritative; test/schema.test.ts checks them.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';
import { approval } from './policy.ts';

/** A device snapshot's Hub copy: keys and hash here, the values sealed under `blob_path`. */
export const firmwareSnapshot = sqliteTable(
  'firmware_snapshot',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    deviceSnapshotId: text('device_snapshot_id').notNull(),
    takenAt: text('taken_at').notNull(),
    keysJson: text('keys_json').notNull().default('[]'),
    sha256: text('sha256').notNull(),
    blobPath: text('blob_path').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_firmware_snapshot_device').on(t.deviceId, t.deviceSnapshotId)],
);

export const FIRMWARE_CHANGE_STATUS_VALUES = [
  'planned',
  'awaiting_approval',
  'approved',
  'applied',
  'rolled_back',
  'failed',
  'reverted',
  'revert_failed',
] as const;

/** One firmware change: a plan's settings (`apply`) or a snapshot restored (`rollback`). */
export const firmwareChange = sqliteTable(
  'firmware_change',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    kind: text('kind', { enum: ['apply', 'rollback'] }).notNull(),
    /** The canonical keys, comma-separated. */
    setting: text('setting').notNull(),
    /** JSON {key: value} before. */
    oldValue: text('old_value'),
    /** JSON {key: value} after. */
    newValue: text('new_value'),
    diffJson: text('diff_json').notNull().default('[]'),
    refusedJson: text('refused_json').notNull().default('[]'),
    method: text('method').notNull(),
    planId: text('plan_id'),
    snapshotRef: text('snapshot_ref').references(() => firmwareSnapshot.id),
    rollbackOf: text('rollback_of').references((): AnySQLiteColumn => firmwareChange.id),
    securityDegrading: integer('security_degrading', { mode: 'boolean' }).notNull().default(false),
    requiresReboot: integer('requires_reboot', { mode: 'boolean' }).notNull().default(false),
    reboot: integer('reboot', { mode: 'boolean' }),
    status: text('status', { enum: FIRMWARE_CHANGE_STATUS_VALUES }).notNull(),
    approvalId: text('approval_id').references(() => approval.id),
    /** The D2 changeId of the last authorization signed for it. */
    changeId: text('change_id'),
    watchdogState: text('watchdog_state', {
      enum: ['pending', 'ok', 'reverted', 'revert_failed', 'missed'],
    }),
    watchdogDeadline: text('watchdog_deadline'),
    /** novad's reason for a revert (`deadline`, `not_restarted`). */
    watchdogReason: text('watchdog_reason'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    appliedAt: text('applied_at'),
  },
  (t) => [
    index('idx_firmware_change_device').on(t.deviceId, t.createdAt),
    uniqueIndex('idx_firmware_change_authz')
      .on(t.changeId)
      .where(sql`change_id IS NOT NULL`),
  ],
);
