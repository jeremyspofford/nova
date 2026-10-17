// M6.5 Network Setup tables (migration 0030_network_setup.sql; FR-136, docs/22 §6): setup runs,
// their steps, snapshots for rollback and remembered consents. SQL migrations are authoritative;
// test/schema.test.ts checks them. No secret is stored (vault refs only); `change_ref` names the
// network area's change-log entry as plain TEXT.
import { index, integer, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { account } from './core.ts';

export const networkSetupRun = sqliteTable(
  'network_setup_run',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    provider: text('provider', {
      enum: ['headscale', 'tailscale', 'netbird', 'wireguard'],
    }).notNull(),
    status: text('status', {
      enum: ['planned', 'in_progress', 'completed', 'failed', 'rolled_back'],
    }).notNull(),
    /** The owner's options with write-only secrets replaced by vault refs. */
    optionsJson: text('options_json').notNull(),
    /** Public material the owner needs (e.g. the Hub's WireGuard public key). */
    outputsJson: text('outputs_json').notNull().default('{}'),
    detectionJson: text('detection_json'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_network_setup_run_account').on(t.accountId, t.createdAt)],
);

export const networkSetupStep = sqliteTable(
  'network_setup_step',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => networkSetupRun.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    idx: integer('idx').notNull(),
    kind: text('kind').notNull(),
    /** `headscale`, `tailscale`, `netbird`, `wireguard`, `ufw`, `os` or `hub`. */
    provider: text('provider').notNull(),
    mode: text('mode', { enum: ['change', 'manual', 'skip', 'check'] }).notNull(),
    title: text('title').notNull(),
    /** What the owner confirms word for word (one-time consent). */
    description: text('description').notNull(),
    commandsJson: text('commands_json').notNull(),
    paramsJson: text('params_json').notNull(),
    affectsJson: text('affects_json').notNull(),
    undoAffectsJson: text('undo_affects_json').notNull(),
    expectsJson: text('expects_json').notNull(),
    systemChange: integer('system_change', { mode: 'boolean' }).notNull(),
    status: text('status', {
      enum: [
        'pending',
        'applied',
        'verified',
        'failed',
        'rolled_back',
        'rollback_failed',
        'manual',
        'skipped',
      ],
    }).notNull(),
    checksJson: text('checks_json').notNull().default('[]'),
    error: text('error'),
    autoRolledBack: integer('auto_rolled_back', { mode: 'boolean' }).notNull().default(false),
    changeRef: text('change_ref'),
    appliedAt: text('applied_at'),
    verifiedAt: text('verified_at'),
    rolledBackAt: text('rolled_back_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [unique().on(t.runId, t.idx)],
);

/** What a step changed, taken before it changed it, and the undo commands planned from it. */
export const networkSetupSnapshot = sqliteTable(
  'network_setup_snapshot',
  {
    id: text('id').primaryKey(),
    stepId: text('step_id')
      .notNull()
      .references(() => networkSetupStep.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => networkSetupRun.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    dataJson: text('data_json').notNull(),
    undoJson: text('undo_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_network_setup_snapshot_step').on(t.stepId, t.createdAt)],
);

/** One-time consent per change kind and provider (docs/22 §6.2), until revoked. */
export const networkSetupConsent = sqliteTable(
  'network_setup_consent',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    description: text('description').notNull(),
    grantedAt: text('granted_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    uniqueIndex('idx_network_setup_consent_active')
      .on(t.accountId, t.kind, t.provider)
      .where(sql`revoked_at IS NULL`),
  ],
);
