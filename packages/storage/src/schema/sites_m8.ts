// M8 sites carry-ins (migration 0052_sites_m8.sql; FR-037, ADR-097): remote hosting targets a
// site version is published to. The same migration rebuilds `site_publish` so a publish may name
// one (spaces.ts). SQL migrations are authoritative; test/schema.test.ts checks them.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** A WebDAV collection site folders go into; its credential is only a `secret://` reference. */
export const siteTarget = sqliteTable(
  'site_target',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['webdav'] }).notNull(),
    url: text('url').notNull(),
    publicUrl: text('public_url'),
    auth: text('auth', { enum: ['none', 'basic', 'bearer'] }).notNull(),
    username: text('username'),
    secretRef: text('secret_ref'),
    checkedAt: text('checked_at'),
    checkOk: integer('check_ok', { mode: 'boolean' }),
    checkReason: text('check_reason'),
    checkMessage: text('check_message'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_site_target_account').on(t.accountId, t.createdAt)],
);
