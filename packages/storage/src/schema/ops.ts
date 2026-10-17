// M3 audit log and notifications (migration 0009_ops.sql). SQL migrations are authoritative;
// test/schema.test.ts checks them.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** Append-only, hash-chained (docs/12 §11); the SQL triggers refuse updates and deletes. */
export const auditEvent = sqliteTable(
  'audit_event',
  {
    id: text('id').primaryKey(),
    /** Position in the hash chain, from 1 with no gaps. */
    seq: integer('seq').notNull().unique(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    actor: text('actor').notNull(),
    kind: text('kind').notNull(),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    runId: text('run_id'),
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    action: text('action').notNull(),
    resource: text('resource'),
    /** SHA-256 of the canonical inputs; inputs are never stored. */
    inputHash: text('input_hash'),
    decision: text('decision'),
    result: text('result'),
    detailJson: text('detail_json'),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_audit_time').on(t.createdAt),
    index('idx_audit_account').on(t.accountId, t.seq),
    index('idx_audit_thread').on(t.threadId, t.seq),
  ],
);

export const notification = sqliteTable(
  'notification',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    kind: text('kind', {
      enum: ['approval', 'completion', 'error', 'attention', 'system'],
    }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** An app path such as `/chat/<id>`. */
    href: text('href'),
    refsJson: text('refs_json'),
    /** Collapses repeats while unread (a partial unique index in the SQL). */
    dedupeKey: text('dedupe_key'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_notification_account').on(t.accountId, t.createdAt)],
);
