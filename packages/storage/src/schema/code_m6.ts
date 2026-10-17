// M6 Code additions (migration 0025_code_m6.sql; docs/10 §2, §7-§10; FR-062, FR-068, FR-070,
// FR-073, FR-078): connected Git hosts, session pull requests with their CI state, auto-verify
// runs and per-session state (budgets, environment setup, task.spawn workers). Saved
// environments reuse `environment` and the worktree registry reuses `worktree` (code.ts). SQL
// migrations are authoritative; test/schema.test.ts checks them. The Hub's code area reads and
// writes these tables with prepared statements.
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { codeSession } from './code.ts';
import { account } from './core.ts';

/** A Git host connected for pushes and pull requests; the token is in the keychain (FR-070). */
export const gitHost = sqliteTable(
  'git_host',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: ['github'] }).notNull(),
    label: text('label').notNull(),
    apiUrl: text('api_url').notNull(),
    webUrl: text('web_url').notNull(),
    login: text('login'),
    /** `secret://code/githost/<id>/token`. */
    tokenRef: text('token_ref').notNull(),
    status: text('status', { enum: ['ok', 'error', 'unknown'] })
      .notNull()
      .default('unknown'),
    statusDetail: text('status_detail'),
    lastCheckAt: text('last_check_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_git_host_web').on(t.accountId, t.webUrl)],
);

/** A pull request a Code session opened, with its last CI state (FR-070). */
export const codePullRequest = sqliteTable(
  'code_pull_request',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    hostId: text('host_id')
      .notNull()
      .references(() => gitHost.id),
    /** `owner/name` on the host. */
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    headBranch: text('head_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    headSha: text('head_sha'),
    state: text('state', { enum: ['open', 'closed', 'merged'] })
      .notNull()
      .default('open'),
    ciStatus: text('ci_status', {
      enum: ['none', 'queued', 'running', 'passed', 'failed'],
    })
      .notNull()
      .default('none'),
    /** The checks as the host reported them (summaries are untrusted text). */
    checksJson: text('checks_json').notNull().default('[]'),
    /** The head whose CI failure was already sent to the agent. */
    feedbackSha: text('feedback_sha'),
    lastPolledAt: text('last_polled_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_code_pull_request_session').on(t.sessionId, t.createdAt),
    index('idx_code_pull_request_open').on(t.state),
  ],
);

/** One auto-verify run of a session (FR-068). */
export const codeVerifyRun = sqliteTable(
  'code_verify_run',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    trigger: text('trigger', { enum: ['auto', 'manual'] }).notNull(),
    turnId: text('turn_id'),
    status: text('status', {
      enum: ['running', 'passed', 'failed', 'error', 'skipped'],
    })
      .notNull()
      .default('running'),
    /** Each check: name, command, status, exit code, a redacted and capped log, duration. */
    checksJson: text('checks_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [index('idx_code_verify_run_session').on(t.sessionId, t.createdAt)],
);

/** Per-session M6 state: budgets and usage, the environment setup, the worker lineage. */
export const codeSessionState = sqliteTable(
  'code_session_state',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => codeSession.id),
    timeLimitS: integer('time_limit_s'),
    tokenLimit: integer('token_limit'),
    costLimitUsd: real('cost_limit_usd'),
    timeUsedMs: integer('time_used_ms').notNull().default(0),
    tokensUsed: integer('tokens_used').notNull().default(0),
    costUsedUsd: real('cost_used_usd').notNull().default(0),
    budgetReached: text('budget_reached', { enum: ['time', 'tokens', 'cost'] }),
    setupStatus: text('setup_status', { enum: ['running', 'ok', 'failed'] }),
    setupDetail: text('setup_detail'),
    /** The session that started this one with task.spawn (FR-073). */
    parentSessionId: text('parent_session_id').references(() => codeSession.id),
    role: text('role'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_code_session_state_parent').on(t.parentSessionId)],
);
