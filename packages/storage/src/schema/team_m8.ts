// M8 team carry-ins (migration 0051_team_m8.sql; decision 5 of ADR-095, ADR-097): the purge of a
// removed member's data. The same migration rebuilds `tool_call` so its origin may be `script`
// (tools.ts). SQL migrations are authoritative; test/schema.test.ts checks them.
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** One purge of a removed member's data and its outcome (the account row itself stays). */
export const memberPurge = sqliteTable(
  'member_purge',
  {
    accountId: text('account_id')
      .primaryKey()
      .references(() => account.id),
    /** `cleaning`: the rows are gone, blobs, vault entries or folders are still to remove. */
    status: text('status', { enum: ['cleaning', 'purged', 'failed'] }).notNull(),
    /** `grace`: the owner's grace period ran out; `request`: the owner purged at once. */
    cause: text('cause', { enum: ['grace', 'request'] }).notNull(),
    requestedBy: text('requested_by').references(() => account.id),
    attemptedAt: text('attempted_at').notNull(),
    purgedAt: text('purged_at'),
    /** Rows deleted per table, blobs, vault entries and folders removed. */
    countsJson: text('counts_json'),
    /** What is left to remove outside the database: `{blobs, secrets, folders}`. */
    cleanupJson: text('cleanup_json'),
    error: text('error'),
  },
  (t) => [index('idx_member_purge_status').on(t.status, t.attemptedAt)],
);
