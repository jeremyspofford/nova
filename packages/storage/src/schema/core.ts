// Foundation tables (0001_init). SQL migrations are authoritative; test/schema.test.ts checks them.
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['local', 'oidc'] }).notNull(),
  displayName: text('display_name'),
  username: text('username'),
  avatarPath: text('avatar_path'),
  email: text('email'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const setting = sqliteTable(
  'setting',
  {
    key: text('key').notNull(),
    scopeKind: text('scope_kind', { enum: ['global', 'project', 'device'] })
      .notNull()
      .default('global'),
    scopeRef: text('scope_ref').notNull().default(''),
    valueJson: text('value_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.scopeKind, t.scopeRef] })],
);

export const event = sqliteTable(
  'event',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    ts: text('ts').notNull(),
    accountId: text('account_id'),
    actor: text('actor').notNull(),
    correlationJson: text('correlation_json'),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => [index('idx_event_ts').on(t.ts), index('idx_event_name').on(t.name, t.ts)],
);

export const featureFlag = sqliteTable('feature_flag', {
  key: text('key').primaryKey(),
  stage: text('stage', {
    enum: ['experimental', 'beta', 'stable', 'deprecated', 'removed'],
  }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const authToken = sqliteTable('auth_token', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['setup', 'session', 'device', 'mcp_client', 'app'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  accountId: text('account_id').references(() => account.id),
  label: text('label'),
  scopes: text('scopes'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

// ---- 0002 chat (M1) ------------------------------------------------------------------------
