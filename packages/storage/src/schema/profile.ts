// M4 active provider accounts and the import ledger (migration 0015_profile.sql; FR-115,
// FR-200). The profile itself uses `account` columns from 0001 (display_name, username,
// avatar_path). SQL migrations are authoritative; test/schema.test.ts checks them.
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/**
 * The active provider account of each provider kind (FR-115). Without a row (or when the row
 * points at a removed account) the oldest live account of the kind is the active one.
 */
export const providerActive = sqliteTable(
  'provider_active',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.provider] })],
);

const IMPORT_SOURCE_KINDS = [
  'instruction_file',
  'skill_folder',
  'command_file',
  'plugin',
  'mcp_config',
  'project',
  'memory_export',
  'chat_export',
] as const;

const IMPORT_ITEM_KINDS = [
  'instruction',
  'skill',
  'plugin',
  'mcp_server',
  'project',
  'memory',
  'thread',
] as const;

/** One imported item: provenance and the SHA-256 dedupe ledger (docs/06, FR-200). */
export const importRecord = sqliteTable(
  'import_record',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    /** Every item of one apply shares it, so an import can be reviewed or removed together. */
    importId: text('import_id').notNull(),
    sourceKind: text('source_kind', { enum: IMPORT_SOURCE_KINDS }).notNull(),
    sourcePath: text('source_path').notNull(),
    /** SHA-256 of the normalized item. */
    sha256: text('sha256').notNull(),
    itemKind: text('item_kind', { enum: IMPORT_ITEM_KINDS }).notNull(),
    /** Id of what it became (a skill id, server id, project id, thread id, ...). */
    targetRef: text('target_ref'),
    /** What it became, for people: "skill review-pr", "MCP server github (disabled)". */
    target: text('target'),
    status: text('status', {
      enum: ['imported', 'disabled_pending_permissions', 'failed'],
    }).notNull(),
    secretsMigrated: integer('secrets_migrated').notNull().default(0),
    importedAt: text('imported_at').notNull(),
  },
  (t) => [
    index('idx_import_record_account').on(t.accountId, t.importedAt),
    index('idx_import_record_import').on(t.importId),
  ],
);
