// M5 Work runs, plans, goals and sub-agents (migration 0016_runs.sql; docs/06 "work runs, goals",
// FR-051..FR-054, FR-181, FR-182, FR-187). SQL migrations are authoritative; test/schema.test.ts
// checks them. `agent_id` columns stay plain TEXT until the `agent` table exists (M6).
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { project, thread } from './chat.ts';
import { account } from './core.ts';

const RUN_STATUS_VALUES = [
  'planning',
  'running',
  'waiting_approval',
  'paused',
  'done',
  'output_missing',
  'failed',
  'cancelled',
] as const;

const RUN_PAUSE_REASON_VALUES = [
  'user',
  'budget_time',
  'budget_tokens',
  'budget_cost',
  'backstop',
  'usage_limit',
  'approval_timeout',
  'review_breaker',
  'safety',
  'error',
] as const;

/** A Work run: a `work` thread plus its supervisor state (FR-051, FR-182). */
export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    projectId: text('project_id').references(() => project.id),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id),
    agentId: text('agent_id'),
    parentRunId: text('parent_run_id').references((): AnySQLiteColumn => run.id),
    origin: text('origin', {
      enum: ['user', 'schedule', 'trigger', 'chat_escalation', 'delegation', 'goal'],
    })
      .notNull()
      .default('user'),
    originRef: text('origin_ref'),
    template: text('template', { enum: ['deep_research'] }),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    /** Whose words the objective carries (FR-189). */
    authority: text('authority', { enum: ['user', 'none'] })
      .notNull()
      .default('none'),
    authoritySource: text('authority_source'),
    model: text('model'),
    status: text('status', { enum: RUN_STATUS_VALUES }).notNull(),
    pauseReason: text('pause_reason', { enum: RUN_PAUSE_REASON_VALUES }),
    statusDetail: text('status_detail'),
    autonomy: text('autonomy', { enum: ['ask_first', 'standard', 'autonomous'] })
      .notNull()
      .default('standard'),
    planApproved: integer('plan_approved', { mode: 'boolean' }).notNull().default(false),
    timeBudgetS: integer('time_budget_s').notNull().default(3600),
    tokenBudget: integer('token_budget').notNull().default(2_000_000),
    costBudgetUsd: real('cost_budget_usd'),
    timeUsedMs: integer('time_used_ms').notNull().default(0),
    tokensUsed: integer('tokens_used').notNull().default(0),
    costUsedUsd: real('cost_used_usd').notNull().default(0),
    progressNote: text('progress_note'),
    pendingJson: text('pending_json'),
    errorCount: integer('error_count').notNull().default(0),
    expectedOutputJson: text('expected_output_json'),
    outputVerifiedAt: text('output_verified_at'),
    resultSummary: text('result_summary'),
    resultJson: text('result_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [
    uniqueIndex('uq_run_thread').on(t.threadId),
    index('idx_run_status').on(t.accountId, t.status, t.updatedAt),
  ],
);

/** A budgeted objective held by a run (FR-181; agents' goals come with M6). */
export const goal = sqliteTable(
  'goal',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    runId: text('run_id').references(() => run.id),
    agentId: text('agent_id'),
    threadId: text('thread_id').references(() => thread.id),
    objective: text('objective').notNull(),
    createdBy: text('created_by', { enum: ['user', 'agent'] })
      .notNull()
      .default('user'),
    status: text('status', {
      enum: ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'],
    })
      .notNull()
      .default('active'),
    statusSetBy: text('status_set_by', { enum: ['user', 'agent', 'system'] })
      .notNull()
      .default('user'),
    statusReason: text('status_reason'),
    progressNote: text('progress_note'),
    completionSummary: text('completion_summary'),
    tokenBudget: integer('token_budget'),
    timeBudgetS: integer('time_budget_s'),
    costBudgetUsd: real('cost_budget_usd'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    timeUsedMs: integer('time_used_ms').notNull().default(0),
    costUsedUsd: real('cost_used_usd').notNull().default(0),
    blockerKey: text('blocker_key'),
    blockerDescription: text('blocker_description'),
    blockerCount: integer('blocker_count').notNull().default(0),
    blockerTurnId: text('blocker_turn_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [index('idx_goal_account').on(t.accountId, t.status, t.updatedAt)],
);

/** One step of a run's plan (docs/09 §3). */
export const runStep = sqliteTable(
  'run_step',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id),
    idx: integer('idx').notNull(),
    title: text('title').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'skipped'],
    }).notNull(),
    detailJson: text('detail_json'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (t) => [uniqueIndex('run_step_run_idx').on(t.runId, t.idx)],
);

/** A sub-agent of a run (FR-053, FR-054). */
export const subagent = sqliteTable(
  'subagent',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id),
    threadId: text('thread_id').references(() => thread.id),
    role: text('role').notNull(),
    objective: text('objective').notNull(),
    toolsJson: text('tools_json'),
    status: text('status', {
      enum: ['queued', 'running', 'done', 'failed', 'cancelled'],
    }).notNull(),
    inboxJson: text('inbox_json'),
    resultJson: text('result_json'),
    createdAt: text('created_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [index('idx_subagent_run').on(t.runId, t.createdAt)],
);
