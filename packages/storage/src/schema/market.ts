// M8 marketplace (migration 0046_market.sql; FR-049, ADR-097 D2): what the marketplace installed,
// with its origin, verification and confirmed permissions, and the ratings the owner gave (kept
// on the Hub). SQL migrations are authoritative; test/schema.test.ts checks them.
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

const KINDS = ['plugin', 'skill', 'theme', 'pet', 'mcp'] as const;

/** One installed item per account, kind and id; an update replaces the row. */
export const marketInstall = sqliteTable(
  'market_install',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: KINDS }).notNull(),
    itemId: text('item_id').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    catalogId: text('catalog_id').notNull(),
    /** `<catalogId>/<id>@<version>`, plus `#<commit>` for Git. */
    origin: text('origin').notNull(),
    signature: text('signature', { enum: ['verified', 'unverified'] }).notNull(),
    publisherKey: text('publisher_key'),
    sha256: text('sha256'),
    commitSha: text('commit_sha'),
    permissionsJson: text('permissions_json').notNull().default('[]'),
    installedAt: text('installed_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_market_install_item').on(t.accountId, t.kind, t.itemId)],
);

/** A rating the owner gave an item (1 to 5 stars); it never leaves the Hub. */
export const marketRating = sqliteTable(
  'market_rating',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: KINDS }).notNull(),
    itemId: text('item_id').notNull(),
    stars: integer('stars').notNull(),
    review: text('review'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_market_rating_item').on(t.accountId, t.kind, t.itemId)],
);
