// M3 memory consolidation runs, topic preferences and per-thread read marks (migration
// 0010_consolidation.sql; FR-204, FR-205). SQL migrations are authoritative;
// test/schema.test.ts checks them.
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { thread } from './chat.ts';

/** One phase of a consolidation job for one scope (docs/06, docs/09 §5). */
export const memoryConsolidationRun = sqliteTable(
  'memory_consolidation_run',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scopeKind: text('scope_kind', { enum: ['global', 'project', 'agent'] }).notNull(),
    scopeRef: text('scope_ref'),
    phase: text('phase', { enum: ['extract', 'consolidate'] }).notNull(),
    status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
    threadsScanned: integer('threads_scanned'),
    itemsCreated: integer('items_created'),
    itemsUpdated: integer('items_updated'),
    itemsAged: integer('items_aged'),
    /** The consolidate phase's summary, at most 2,500 tokens; cleared when items change. */
    summary: text('summary'),
    summaryTokens: integer('summary_tokens'),
    modelId: text('model_id'),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [
    index('idx_consolidation_run_scope').on(
      t.accountId,
      t.scopeKind,
      t.scopeRef,
      t.phase,
      t.startedAt,
    ),
    index('idx_consolidation_run_account').on(t.accountId, t.startedAt),
  ],
);

/** "Remember more / less about this topic" (FR-204). */
export const memoryTopic = sqliteTable(
  'memory_topic',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    /** Case-folded topic used for matching. */
    topicKey: text('topic_key').notNull(),
    topic: text('topic').notNull(),
    preference: text('preference', { enum: ['more', 'less'] }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.topicKey] })],
);

/** The last message consolidation read in each thread. */
export const memoryThreadMark = sqliteTable('memory_thread_mark', {
  threadId: text('thread_id')
    .primaryKey()
    .references(() => thread.id, { onDelete: 'cascade' }),
  accountId: text('account_id')
    .notNull()
    .references(() => account.id),
  lastMessageId: text('last_message_id').notNull(),
  runId: text('run_id'),
  updatedAt: text('updated_at').notNull(),
});
