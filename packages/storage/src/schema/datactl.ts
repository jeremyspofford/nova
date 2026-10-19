// M8 data controls (migration 0048_datactl.sql; FR-105, FR-116; ADR-097 D5): spend caps per
// provider and the alerts they fired, retention sweeps, and the anchor of a pruned audit chain.
// SQL migrations are authoritative; test/schema.test.ts checks them.
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** A spend cap per account and provider kind (FR-116). */
export const spendCap = sqliteTable(
  'spend_cap',
  {
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => account.id),
    provider: text('provider').notNull(),
    limitUsd: real('limit_usd').notNull(),
    period: text('period', { enum: ['day', 'month'] })
      .notNull()
      .default('month'),
    warnAt: real('warn_at').notNull().default(0.8),
    hardStop: integer('hard_stop', { mode: 'boolean' }).notNull().default(true),
    /** Spend of `carriedPeriodStart` that "clear usage data" removed from usage_event. */
    carriedUsd: real('carried_usd').notNull().default(0),
    carriedPeriodStart: text('carried_period_start'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.provider] })],
);

/** The warning and the "cap reached" notice, once per cap, period and level. */
export const spendAlert = sqliteTable(
  'spend_alert',
  {
    accountId: text('account_id').notNull(),
    provider: text('provider').notNull(),
    periodStart: text('period_start').notNull(),
    level: text('level', { enum: ['warning', 'reached'] }).notNull(),
    spentUsd: real('spent_usd').notNull(),
    limitUsd: real('limit_usd').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.provider, t.periodStart, t.level] })],
);

/** One retention sweep and what each item removed. */
export const retentionSweep = sqliteTable(
  'retention_sweep',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['schedule', 'manual'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    resultJson: text('result_json'),
    error: text('error'),
  },
  (t) => [index('idx_retention_sweep_started').on(t.startedAt)],
);

/** Where a pruned audit chain starts (the last pruned entry's seq and hash). */
export const auditAnchor = sqliteTable('audit_anchor', {
  id: integer('id').primaryKey(),
  seq: integer('seq').notNull(),
  hash: text('hash').notNull(),
  prunedAt: text('pruned_at').notNull(),
});
