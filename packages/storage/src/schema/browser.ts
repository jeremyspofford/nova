// M6 browser tables (migration 0023_browser.sql; FR-086, FR-094, FR-098). SQL migrations are
// authoritative; test/schema.test.ts checks them. Computer, thread, turn and call ids are plain
// text (no foreign keys); secrets live in the vault, never here.
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** Allowed sites (with a level and the developer-protocol mode) and blocked sites (FR-094). */
export const browserSite = sqliteTable(
  'browser_site',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    pattern: text('pattern').notNull(),
    access: text('access', { enum: ['allow', 'block'] }).notNull(),
    level: text('level', { enum: ['always_ask', 'auto_review', 'always_allow'] }),
    devProtocol: integer('dev_protocol', { mode: 'boolean' }).notNull().default(false),
    /** The site-scoped policy_rule that enforces the level. */
    ruleId: text('rule_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.pattern] })],
);

/** One browser action with its before/after screenshots (FR-098). */
export const browserAction = sqliteTable(
  'browser_action',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    computerId: text('computer_id').notNull(),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    callId: text('call_id'),
    tool: text('tool').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    url: text('url'),
    host: text('host'),
    result: text('result', {
      enum: ['ok', 'error', 'blocked', 'denied', 'handoff'],
    }).notNull(),
    error: text('error'),
    classificationJson: text('classification_json'),
    /** Relative to the data directory: blobs/screenshots/<yyyymmdd>/<id>.png. */
    beforePath: text('before_path'),
    afterPath: text('after_path'),
    approvalId: text('approval_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_browser_action_thread').on(t.accountId, t.threadId, t.createdAt),
    index('idx_browser_action_call').on(t.callId),
    index('idx_browser_action_created').on(t.createdAt),
  ],
);

/** Saved logins (FR-086): the password is a vault entry (`secretRef`). */
export const browserLogin = sqliteTable(
  'browser_login',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    host: text('host').notNull(),
    username: text('username').notNull(),
    secretRef: text('secret_ref').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [unique().on(t.accountId, t.host, t.username)],
);
