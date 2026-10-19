// M7 Code additions (migration 0036_code_m7.sql; docs/10 §9, §14, §15; FR-212, FR-213, FR-073):
// session handoffs with their Git state, best-of-N attempt sets and attempts, three-way merges and
// delegations from an agent to a Code session. SQL migrations are authoritative;
// test/schema.test.ts checks them. The Hub's code area reads and writes these tables with prepared
// statements.
import { index, integer, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { thread } from './chat.ts';
import { codeSession } from './code.ts';
import { account } from './core.ts';

/** A move of a Code session (or a chat) to another device, environment or worktree (FR-213). */
export const sessionHandoff = sqliteTable(
  'session_handoff',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id),
    /** Null for a chat handoff. */
    codeSessionId: text('code_session_id').references(() => codeSession.id),
    /** `environment:<id>`, `worktree:<id>`, `device:<id>` or `hub`. */
    fromRef: text('from_ref').notNull(),
    toRef: text('to_ref').notNull(),
    fromLabel: text('from_label').notNull(),
    toLabel: text('to_label').notNull(),
    targetFolder: text('target_folder'),
    sourceAction: text('source_action', { enum: ['keep', 'clean'] })
      .notNull()
      .default('keep'),
    gitStateJson: text('git_state_json'),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'refused', 'failed'],
    })
      .notNull()
      .default('pending'),
    reason: text('reason'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    index('idx_session_handoff_thread').on(t.threadId, t.createdAt),
    index('idx_session_handoff_session').on(t.codeSessionId, t.createdAt),
  ],
);

/** A best-of-N task: N attempts of one objective from the session's HEAD (FR-212). */
export const codeAttemptSet = sqliteTable(
  'code_attempt_set',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    objective: text('objective').notNull(),
    baseSha: text('base_sha').notNull(),
    status: text('status', { enum: ['running', 'ready', 'applied', 'discarded'] })
      .notNull()
      .default('running'),
    appliedAttemptId: text('applied_attempt_id'),
    mergeId: text('merge_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_code_attempt_set_session').on(t.sessionId, t.createdAt)],
);

/** One attempt: its own Code session in its own worktree. */
export const codeAttempt = sqliteTable(
  'code_attempt',
  {
    id: text('id').primaryKey(),
    setId: text('set_id')
      .notNull()
      .references(() => codeAttemptSet.id),
    idx: integer('idx').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    modelId: text('model_id'),
    status: text('status', { enum: ['running', 'done', 'failed', 'applied', 'discarded'] })
      .notNull()
      .default('running'),
    /** The attempt's last reply (untrusted). */
    reply: text('reply'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [unique().on(t.setId, t.idx), index('idx_code_attempt_session').on(t.sessionId)],
);

/** A three-way merge onto a session's folder, with its conflicts (docs/10 §9, §14). */
export const codeMerge = sqliteTable(
  'code_merge',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    sourceKind: text('source_kind', { enum: ['session', 'attempt', 'patch'] }).notNull(),
    sourceRef: text('source_ref'),
    baseSha: text('base_sha'),
    status: text('status', {
      enum: ['applied', 'conflicted', 'resolved', 'refused', 'aborted'],
    }).notNull(),
    filesJson: text('files_json').notNull().default('[]'),
    conflictsJson: text('conflicts_json').notNull().default('[]'),
    /** The files as they were before the merge (under the data folder), for an abort. */
    backupPath: text('backup_path'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('idx_code_merge_session').on(t.sessionId, t.createdAt)],
);

/** A Code session an agent started with `code.delegate` (its rules apply there). */
export const codeDelegation = sqliteTable(
  'code_delegation',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    agentId: text('agent_id').notNull(),
    agentThreadId: text('agent_thread_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    threadId: text('thread_id').notNull(),
    status: text('status', { enum: ['running', 'done', 'failed'] })
      .notNull()
      .default('running'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    uniqueIndex('idx_code_delegation_thread').on(t.threadId),
    index('idx_code_delegation_agent').on(t.agentId, t.createdAt),
  ],
);
