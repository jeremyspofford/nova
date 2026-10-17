// M4 plugins, skills and sub-agent roles (migration 0011_plugins.sql; docs/06 §2, FR-045,
// FR-046). SQL migrations are authoritative; test/schema.test.ts checks them.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** An installed plugin; its files live in `<dataDir>/plugins/<pluginId>/<version>/`. */
export const pluginInstall = sqliteTable(
  'plugin_install',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    pluginId: text('plugin_id').notNull(),
    version: text('version').notNull(),
    source: text('source', { enum: ['local', 'catalog', 'git'] }).notNull(),
    origin: text('origin').notNull(),
    /** The validated manifest; its `permissions` block is what the user confirmed. */
    manifestJson: text('manifest_json').notNull(),
    signature: text('signature', { enum: ['verified', 'unverified'] })
      .notNull()
      .default('unverified'),
    installPath: text('install_path').notNull(),
    /** JSON: MCP server ids by manifest key, skills, commands, roles and hooks registered. */
    registrationsJson: text('registrations_json').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
    installedAt: text('installed_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_plugin_install_plugin').on(t.accountId, t.pluginId)],
);

/** The enabled switch and import provenance of a skill discovered on disk (ADR-067). */
export const skillState = sqliteTable(
  'skill_state',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    /** `skill:<source or pluginId>:<name>`. */
    skillId: text('skill_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    origin: text('origin', { enum: ['import'] }),
    provenanceJson: text('provenance_json'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.skillId] })],
);

/** A plugin's sub-agent role, `role:<pluginId>:<name>` (docs/08 §3.1; used in M5). */
export const agentRole = sqliteTable(
  'agent_role',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    roleKey: text('role_key').notNull(),
    pluginId: text('plugin_id'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** JSON array of tool names the role may use. */
    toolsJson: text('tools_json').notNull(),
    modelHint: text('model_hint'),
    instructions: text('instructions').notNull(),
    sourcePath: text('source_path').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_agent_role_key').on(t.accountId, t.roleKey),
    index('idx_agent_role_plugin').on(t.accountId, t.pluginId),
  ],
);
