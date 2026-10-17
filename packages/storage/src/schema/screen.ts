// M6 screen tables (migration 0027_screen.sql; FR-093, FR-207, FR-098, FR-087, FR-075). SQL
// migrations are authoritative; test/schema.test.ts checks them. Computer, thread and turn ids
// are plain columns (no foreign keys).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { artifact } from './tools.ts';

export const screenControl = sqliteTable('screen_control', {
  computerId: text('computer_id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => account.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Set by the kill key; cleared when the user resumes control. */
  stoppedAt: text('stopped_at'),
  /** `user`, `key` or `system`. */
  stoppedBy: text('stopped_by'),
  updatedAt: text('updated_at').notNull(),
});

export const screenGrant = sqliteTable(
  'screen_grant',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    computerId: text('computer_id').notNull(),
    app: text('app').notNull(),
    tier: text('tier', { enum: ['view', 'click', 'full'] }).notNull(),
    grantedBy: text('granted_by').notNull(),
    threadId: text('thread_id'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    renewedAt: text('renewed_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('idx_screen_grant_computer').on(t.computerId, t.expiresAt)],
);

export const screenAction = sqliteTable(
  'screen_action',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    computerId: text('computer_id').notNull(),
    /** `user`, `system` or `agent:<id>`. */
    actor: text('actor').notNull(),
    origin: text('origin', { enum: ['tool', 'takeover'] }).notNull(),
    kind: text('kind', { enum: ['click', 'scroll', 'type', 'key', 'drag'] }).notNull(),
    /** Redacted: typed text is kept as its length only. */
    argsJson: text('args_json').notNull(),
    app: text('app'),
    windowTitle: text('window_title'),
    tier: text('tier', { enum: ['none', 'view', 'click', 'full'] }),
    status: text('status', { enum: ['ok', 'refused', 'failed', 'stopped'] }).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    callId: text('call_id'),
    takeoverId: text('takeover_id'),
    beforeBlob: text('before_blob'),
    afterBlob: text('after_blob'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    index('idx_screen_action_computer').on(t.computerId, t.id),
    index('idx_screen_action_created').on(t.createdAt),
  ],
);

export const screenTakeover = sqliteTable('screen_takeover', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => account.id),
  computerId: text('computer_id').notNull(),
  surface: text('surface', { enum: ['desktop', 'browser'] }).notNull(),
  startedBy: text('started_by').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  /** `returned` or `restart`. */
  endReason: text('end_reason'),
  inputCount: integer('input_count').notNull().default(0),
});

export const screenAppshot = sqliteTable(
  'screen_appshot',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    computerId: text('computer_id').notNull(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id),
    source: text('source', { enum: ['window', 'screen', 'browser'] }).notNull(),
    app: text('app'),
    windowTitle: text('window_title'),
    url: text('url'),
    width: integer('width'),
    height: integer('height'),
    threadId: text('thread_id'),
    capturedBy: text('captured_by').notNull(),
    capturedAt: text('captured_at').notNull(),
  },
  (t) => [index('idx_screen_appshot_computer').on(t.computerId, t.capturedAt)],
);
