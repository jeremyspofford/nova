// M4 app authorizations for Nova's MCP server and OAuth for remote MCP servers (migration
// 0013_apps.sql; docs/06 §2, FR-044, FR-047, FR-192). MCP bundle installs use the bundle columns
// of `mcp_server`. SQL migrations are authoritative; test/schema.test.ts checks them.
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { mcpServer } from './mcp.ts';

export const appAuthorization = sqliteTable(
  'app_authorization',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: ['mcp_client', 'app'] }).notNull(),
    clientName: text('client_name').notNull(),
    /** JSON: AppAuthorizationView.scopes. */
    scopes: text('scopes').notNull(),
    /** SHA-256 of the bearer token; the token itself is shown once and never stored. */
    tokenHash: text('token_hash').unique(),
    status: text('status', { enum: ['pending', 'active', 'revoked'] })
      .notNull()
      .default('pending'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('idx_app_authorization_account').on(t.accountId, t.status)],
);

export const mcpOauth = sqliteTable('mcp_oauth', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => mcpServer.id, { onDelete: 'cascade' }),
  accountId: text('account_id')
    .notNull()
    .references(() => account.id),
  issuer: text('issuer').notNull(),
  /** JSON: the authorization server's RFC 8414 metadata. */
  metadataJson: text('metadata_json').notNull(),
  resource: text('resource'),
  clientId: text('client_id').notNull(),
  clientSecretRef: text('client_secret_ref'),
  registration: text('registration', { enum: ['metadata_document', 'dynamic'] }).notNull(),
  scopesJson: text('scopes_json').notNull().default('[]'),
  accessTokenRef: text('access_token_ref'),
  refreshTokenRef: text('refresh_token_ref'),
  status: text('status', { enum: ['needs_auth', 'connected', 'expired', 'error'] })
    .notNull()
    .default('needs_auth'),
  expiresAt: text('expires_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
