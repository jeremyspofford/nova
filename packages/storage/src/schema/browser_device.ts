// M7.5 browser_device (migration 0043_browser_device.sql; FR-209, FR-096; ADR-096 D7, D8): the
// local browser fallback's consents, sessions and trace marks, and the extension bridge's per-host
// grants. SQL migrations are authoritative; test/schema.test.ts checks them. Device, computer and
// thread ids are plain text (no foreign keys); nothing secret is stored.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { browserAction } from './browser.ts';
import { account } from './core.ts';

/** A revocable consent to continue a site on a device's browser, per agent or thread. */
export const browserFallbackConsent = sqliteTable(
  'browser_fallback_consent',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scopeKind: text('scope_kind', { enum: ['agent', 'thread'] }).notNull(),
    scopeRef: text('scope_ref').notNull(),
    deviceId: text('device_id').notNull(),
    site: text('site').notNull(),
    profile: text('profile', { enum: ['clean', 'extension'] }).notNull(),
    grantedBy: text('granted_by').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    revokedBy: text('revoked_by'),
  },
  (t) => [
    uniqueIndex('ux_browser_fallback_consent_live')
      .on(t.accountId, t.scopeKind, t.scopeRef, t.deviceId, t.site)
      .where(sql`revoked_at IS NULL`),
    index('idx_browser_fallback_consent_device').on(t.deviceId),
  ],
);

/** One local-fallback browser session (D7). */
export const browserFallbackSession = sqliteTable(
  'browser_fallback_session',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    computerId: text('computer_id').notNull(),
    threadId: text('thread_id'),
    deviceId: text('device_id').notNull(),
    site: text('site').notNull(),
    profile: text('profile', { enum: ['clean', 'extension'] }).notNull(),
    cause: text('cause', {
      enum: ['block_page', 'repeated_challenge', 'requested'],
    }).notNull(),
    consentId: text('consent_id').references(() => browserFallbackConsent.id),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    endReason: text('end_reason', {
      enum: [
        'closed',
        'left_site',
        'consent_revoked',
        'device_gone',
        'error',
        'disabled',
        'restarted',
      ],
    }),
    egressAllowed: integer('egress_allowed'),
    egressRefused: integer('egress_refused'),
    /** In the user's own browser: the OS user whose browser it was. */
    bridgeUser: text('bridge_user'),
  },
  (t) => [
    index('idx_browser_fallback_session_computer').on(t.accountId, t.computerId, t.startedAt),
  ],
);

/** The trace mark: a browser_action row recorded during a fallback session. */
export const browserFallbackAction = sqliteTable(
  'browser_fallback_action',
  {
    actionId: text('action_id')
      .primaryKey()
      .references(() => browserAction.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => browserFallbackSession.id, { onDelete: 'cascade' }),
  },
  (t) => [index('idx_browser_fallback_action_session').on(t.sessionId)],
);

/** A per-host grant of the extension bridge; host `*` is "all sites" (FR-096). */
export const browserBridgeGrant = sqliteTable(
  'browser_bridge_grant',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id').notNull(),
    host: text('host').notNull(),
    state: text('state', { enum: ['pending', 'active', 'revoked'] }).notNull(),
    browserPermission: integer('browser_permission', { mode: 'boolean' }).notNull().default(false),
    confirmedBy: text('confirmed_by'),
    confirmedAt: text('confirmed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revokedAt: text('revoked_at'),
    revokedBy: text('revoked_by'),
  },
  (t) => [
    uniqueIndex('ux_browser_bridge_grant_live')
      .on(t.deviceId, t.host)
      .where(sql`state <> 'revoked'`),
    index('idx_browser_bridge_grant_account').on(t.accountId, t.deviceId),
  ],
);
