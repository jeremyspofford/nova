// M3 MCP client servers (migration 0008_mcp.sql; docs/06 §2, FR-042). SQL migrations are
// authoritative; test/schema.test.ts checks them.
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';

export const mcpServer = sqliteTable(
  'mcp_server',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    transport: text('transport', { enum: ['stdio', 'sse', 'http'] }).notNull(),
    command: text('command'),
    /** JSON array of arguments. */
    argsJson: text('args_json'),
    url: text('url'),
    /** JSON map NAME → `secret://` reference; values live in the vault only. */
    envRefJson: text('env_ref_json'),
    /** JSON: timeouts, tool lists, defaultApproval and header references. */
    configJson: text('config_json'),
    source: text('source', {
      enum: ['user', 'plugin', 'bundle', 'import', 'managed', 'device'],
    })
      .notNull()
      .default('user'),
    pluginId: text('plugin_id'),
    deviceId: text('device_id').references(() => device.id),
    bundleManifestJson: text('bundle_manifest_json'),
    signatureStatus: text('signature_status', { enum: ['verified', 'unverified'] }),
    bundleSha256: text('bundle_sha256'),
    installRecordJson: text('install_record_json'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_mcp_server_name').on(t.accountId, t.name)],
);
