// M7 cloud runner tables (migration 0034_runner.sql; FR-108, FR-071, FR-116; docs/13 §3,
// ADR-095). A cloud environment itself is an `environment` row of kind `cloud` (code.ts). SQL
// migrations are authoritative; test/schema.test.ts checks them. The runner token is a vault entry;
// no row holds it. Thread and Work run ids are plain (threads can be purged).
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { environment } from './code.ts';
import { account } from './core.ts';

/** A Code session's or Work run's lease on a cloud environment, with its metering (FR-116). */
export const cloudRun = sqliteTable(
  'cloud_run',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id),
    threadId: text('thread_id'),
    kind: text('kind', { enum: ['code', 'work', 'system'] }).notNull(),
    workRunId: text('work_run_id'),
    runnerRunId: text('runner_run_id').notNull(),
    status: text('status', {
      enum: ['active', 'completed', 'cancelled', 'capped', 'failed', 'lost'],
    })
      .notNull()
      .default('active'),
    reason: text('reason'),
    cpuCapS: integer('cpu_cap_s').notNull(),
    wallCapS: integer('wall_cap_s').notNull(),
    cpuUsedS: real('cpu_used_s').notNull().default(0),
    wallUsedS: real('wall_used_s').notNull().default(0),
    commands: integer('commands').notNull().default(0),
    warningsJson: text('warnings_json').notNull().default('[]'),
    lastEventId: integer('last_event_id').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [
    index('idx_cloud_run_thread').on(t.accountId, t.threadId, t.status),
    index('idx_cloud_run_environment').on(t.environmentId, t.status),
    uniqueIndex('idx_cloud_run_runner').on(t.runnerRunId),
  ],
);

/** A Work run whose commands and files go to a cloud environment. */
export const cloudWorkBinding = sqliteTable(
  'cloud_work_binding',
  {
    threadId: text('thread_id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id),
    workRunId: text('work_run_id').notNull(),
    folder: text('folder').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_cloud_work_binding_environment').on(t.environmentId)],
);

/** The Hub's index of a cloud environment's snapshots (the tar stays on the runner). */
export const cloudSnapshot = sqliteTable(
  'cloud_snapshot',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.id),
    runnerSnapshotId: text('runner_snapshot_id').notNull(),
    label: text('label'),
    reason: text('reason', { enum: ['manual', 'run_start', 'before_restore'] }).notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    createdAt: text('created_at').notNull(),
    restoredAt: text('restored_at'),
  },
  (t) => [index('idx_cloud_snapshot_environment').on(t.environmentId, t.createdAt)],
);
