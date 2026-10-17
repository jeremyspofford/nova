// M5 schedules and their history (migration 0017_schedules.sql; docs/06 `schedule`, FR-055,
// FR-187, ADR-079). SQL migrations are authoritative; test/schema.test.ts checks them. `agent_id`
// stays plain TEXT until the `agent` table exists (M6); run ids are plain TEXT so the history
// outlives a deleted run.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { project } from './chat.ts';
import { account } from './core.ts';

const OUTCOMES = ['done', 'output_missing', 'failed', 'cancelled', 'no_news'] as const;

/** A recurring task, agent schedule or self-set wake (schedule.json). */
export const schedule = sqliteTable(
  'schedule',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    projectId: text('project_id').references(() => project.id),
    /** The Work run the schedule was made from, if any. */
    runId: text('run_id'),
    agentId: text('agent_id'),
    title: text('title').notNull(),
    cron: text('cron'),
    rrule: text('rrule'),
    intervalSeconds: integer('interval_seconds'),
    onceAt: text('once_at'),
    timezone: text('timezone').notNull(),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
    instructions: text('instructions').notNull(),
    notifyCondition: text('notify_condition'),
    deliveryTargetsJson: text('delivery_targets_json').notNull(),
    expectedOutputJson: text('expected_output_json'),
    catchUpPolicy: text('catch_up_policy', { enum: ['once', 'skip'] })
      .notNull()
      .default('once'),
    catchUpLookbackS: integer('catch_up_lookback_s').notNull().default(604_800),
    autonomy: text('autonomy', { enum: ['ask_first', 'standard', 'autonomous'] })
      .notNull()
      .default('standard'),
    origin: text('origin', { enum: ['user', 'agent', 'agent_self'] })
      .notNull()
      .default('user'),
    wakeReason: text('wake_reason'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: text('last_run_at'),
    nextRunAt: text('next_run_at'),
    lastOutcome: text('last_outcome', { enum: OUTCOMES }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_schedule_next').on(t.nextRunAt),
    index('idx_schedule_account').on(t.accountId, t.createdAt),
  ],
);

/** One entry of a schedule's history: a fire, a catch-up run or recorded misses (ADR-079). */
export const scheduleFire = sqliteTable(
  'schedule_fire',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedule.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: ['fire', 'catch_up', 'skipped'] }).notNull(),
    /** The rule time it stands for; null for a run started by hand. */
    dueAt: text('due_at'),
    windowFirst: text('window_first'),
    windowLast: text('window_last'),
    windowCount: integer('window_count'),
    runId: text('run_id'),
    threadId: text('thread_id'),
    /** The run's schedule.report decision: true deliver, false no news, null not reported. */
    notify: integer('notify', { mode: 'boolean' }),
    reportMessage: text('report_message'),
    receiptsJson: text('receipts_json'),
    outcome: text('outcome', { enum: OUTCOMES }),
    detail: text('detail'),
    firedAt: text('fired_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [
    uniqueIndex('uq_schedule_fire_due').on(t.scheduleId, t.kind, t.dueAt),
    index('idx_schedule_fire_schedule').on(t.scheduleId, t.firedAt),
    index('idx_schedule_fire_open').on(t.accountId, t.threadId),
  ],
);
