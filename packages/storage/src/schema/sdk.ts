// M8 extension SDK (migration 0045_sdk.sql; FR-117, ADR-097 D2-D3): what an installed extension
// adds to its plugin row: the bundle digest, the signature check, the publisher key and the
// validated extension.json. SQL migrations are authoritative; test/schema.test.ts checks them.
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** One installed extension per account and plugin id (its plugin is `plugin_install`). */
export const extensionInstall = sqliteTable(
  'extension_install',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    pluginId: text('plugin_id').notNull(),
    version: text('version').notNull(),
    api: integer('api').notNull(),
    signature: text('signature', { enum: ['verified', 'unverified', 'dev'] }).notNull(),
    /** base64url of the raw Ed25519 key that signed the bundle; null when unsigned. */
    publisherKey: text('publisher_key'),
    /** D2 digest of the bundle's files (lower-case hex SHA-256). */
    digest: text('digest').notNull(),
    /** The validated extension.json; its `permissions` is what the owner confirmed. */
    manifestJson: text('manifest_json').notNull(),
    lastError: text('last_error'),
    installedAt: text('installed_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_extension_install_plugin').on(t.accountId, t.pluginId)],
);
