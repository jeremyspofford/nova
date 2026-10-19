// M7.5 boot (migration 0041_boot.sql; FR-143, ADR-096 D5): boot profiles, the boot requests the
// owner approved for a device, one-shot attempts with the Hub's watchdog, and PXE boot tokens.
// SQL migrations are authoritative; test/schema.test.ts checks them.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';
import { approval } from './policy.ts';

/** A named bootloader entry of a device (kernel arguments are not supported in M7.5). */
export const bootProfile = sqliteTable(
  'boot_profile',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    name: text('name').notNull(),
    entryId: text('entry_id').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    uniqueIndex('idx_boot_profile_name')
      .on(t.deviceId, t.name)
      .where(sql`deleted_at IS NULL`),
  ],
);

/** A privileged boot change (`try`, `commit`, `revert`), sent once after its approval. */
export const bootRequest = sqliteTable(
  'boot_request',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    kind: text('kind', { enum: ['try', 'commit', 'revert'] }).notNull(),
    profileId: text('profile_id').references(() => bootProfile.id),
    attemptId: text('attempt_id'),
    entryId: text('entry_id'),
    /** Canonical JSON of the device body without its authorization: what the approval covers. */
    bodyJson: text('body_json').notNull(),
    /** The device's boot state when the owner asked: the card's "from" and the audit's before. */
    beforeJson: text('before_json').notNull().default('{}'),
    approvalId: text('approval_id').references(() => approval.id),
    /** The device authorization's changeId (UUIDv7, never reused). */
    changeId: text('change_id').notNull().unique(),
    status: text('status', {
      enum: ['awaiting_approval', 'denied', 'expired', 'sent', 'failed'],
    }).notNull(),
    errorCode: text('error_code'),
    errorReason: text('error_reason'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    decidedAt: text('decided_at'),
    sentAt: text('sent_at'),
  },
  (t) => [
    index('idx_boot_request_device').on(t.deviceId, t.createdAt),
    index('idx_boot_request_approval').on(t.approvalId),
  ],
);

/** A one-shot trial of a profile; at most one pending per device. */
export const bootAttempt = sqliteTable(
  'boot_attempt',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    profileId: text('profile_id')
      .notNull()
      .references(() => bootProfile.id),
    requestId: text('request_id')
      .notNull()
      .references(() => bootRequest.id),
    entryId: text('entry_id').notNull(),
    status: text('status', { enum: ['pending', 'ok', 'reverted', 'failed'] }).notNull(),
    reboot: integer('reboot', { mode: 'boolean' }).notNull(),
    watchdogSeconds: integer('watchdog_seconds').notNull(),
    deadline: text('deadline').notNull(),
    reason: text('reason'),
    detail: text('detail'),
    /** The device saw the trial entry booted (null: no report yet). */
    verified: integer('verified', { mode: 'boolean' }),
    committedAt: text('committed_at'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    uniqueIndex('idx_boot_attempt_pending')
      .on(t.deviceId)
      .where(sql`status = 'pending'`),
    index('idx_boot_attempt_device').on(t.deviceId, t.createdAt),
  ],
);

/** A device's PXE boot token: only its SHA-256 is kept; at most one active per device. */
export const pxeToken = sqliteTable(
  'pxe_token',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [
    uniqueIndex('idx_pxe_token_active')
      .on(t.deviceId)
      .where(sql`revoked_at IS NULL`),
  ],
);
