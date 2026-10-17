// M4 lifecycle hooks and their trust records (0012_hooks; docs/06 `hook`; FR-197, ADR-068). SQL
// migrations are authoritative; test/schema.test.ts checks them. The per-source key is a unique
// expression index in the SQL (COALESCE over the nullable plugin and project ids).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { project } from './chat.ts';
import { account } from './core.ts';

export const HOOK_EVENT_VALUES = [
  'session.start',
  'session.end',
  'prompt.submit',
  'tool.pre',
  'permission.request',
  'tool.post',
  'compact.pre',
  'compact.post',
  'subagent.start',
  'subagent.stop',
  'stop',
  'interrupt',
] as const;

/** One hook found in a source, with its trust record (hook-config.json#/$defs/trustRecord). */
export const hook = sqliteTable(
  'hook',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    /** The hook's id in its file, unique per source. */
    hookKey: text('hook_key').notNull(),
    event: text('event', { enum: HOOK_EVENT_VALUES }).notNull(),
    /** JSON glob list; null = every occurrence. */
    matcherJson: text('matcher_json'),
    handlerKind: text('handler_kind', { enum: ['command', 'mcp_tool'] }).notNull(),
    handlerJson: text('handler_json').notNull(),
    failClosed: integer('fail_closed', { mode: 'boolean' }).notNull().default(false),
    source: text('source', {
      enum: ['managed', 'user', 'project', 'plugin', 'extension'],
    }).notNull(),
    pluginId: text('plugin_id'),
    projectId: text('project_id').references(() => project.id, { onDelete: 'cascade' }),
    /** The definition as found (what is hashed, without `enabled`). */
    definitionJson: text('definition_json').notNull(),
    /** The plugin or project folder a command hook runs in. */
    baseDir: text('base_dir'),
    /** Plugin hooks: `{network, fsProject, answersAsks}` from the plugin's permissions. */
    limitsJson: text('limits_json'),
    contentHash: text('content_hash').notNull(),
    trustedHash: text('trusted_hash'),
    trustState: text('trust_state', { enum: ['needs_trust', 'trusted', 'revoked'] })
      .notNull()
      .default('needs_trust'),
    trustedBy: text('trusted_by'),
    trustedAt: text('trusted_at'),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: text('last_run_at'),
    lastEffect: text('last_effect', {
      enum: ['none', 'context', 'decision', 'continue', 'blocked', 'error'],
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_hook_event').on(t.accountId, t.event)],
);
