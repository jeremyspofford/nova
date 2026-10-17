// Device tables (0005_nodes; docs/06 §7), used for compute nodes in M2 (FR-126). SQL migrations
// are authoritative; test/schema.test.ts checks them.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account, authToken } from './core.ts';

export const device = sqliteTable(
  'device',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['hub', 'compute', 'client', 'wake-helper'] }).notNull(),
    platform: text('platform'),
    /** SHA-256 of the public key until certificates exist (M6.5). */
    certFingerprint: text('cert_fingerprint').notNull().unique(),
    /** Raw Ed25519 public key, base64url; pinned at registration. */
    publicKey: text('public_key').notNull(),
    /** JSON array of roles. */
    roles: text('roles').notNull(),
    scopes: text('scopes'),
    status: text('status', { enum: ['pending', 'active', 'revoked', 'unreachable'] })
      .notNull()
      .default('pending'),
    novadVersion: text('novad_version'),
    relayClientId: text('relay_client_id').unique(),
    relayRouteId: text('relay_route_id').unique(),
    offlineReplica: integer('offline_replica', { mode: 'boolean' }).notNull().default(false),
    localRuntime: integer('local_runtime', { mode: 'boolean' }).notNull().default(false),
    /** The node credential (auth_token kind 'device'); null once revoked. */
    credentialTokenId: text('credential_token_id').references(() => authToken.id),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_device_account').on(t.accountId, t.kind, t.status),
    index('idx_device_credential').on(t.credentialTokenId),
  ],
);

export const deviceCapability = sqliteTable('device_capability', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => device.id),
  /** JSON, schema contracts/schemas/device-capability.json. */
  document: text('document').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const transportEndpoint = sqliteTable(
  'transport_endpoint',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id').references(() => device.id),
    net: text('net', { enum: ['lan', 'mesh', 'relay', 'direct'] }).notNull(),
    url: text('url').notNull(),
    healthy: integer('healthy', { mode: 'boolean' }).notNull().default(true),
    latencyMs: integer('latency_ms'),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_transport_endpoint_device').on(t.deviceId)],
);

export const addDeviceRequest = sqliteTable(
  'add_device_request',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    role: text('role', { enum: ['client', 'compute', 'wake-helper'] }).notNull(),
    /** Hash of the one-use enrollment token; the token itself is shown once. */
    codeHash: text('code_hash').notNull(),
    scopes: text('scopes'),
    via: text('via', { enum: ['direct', 'relay'] })
      .notNull()
      .default('direct'),
    status: text('status', { enum: ['pending', 'approved', 'expired', 'denied'] })
      .notNull()
      .default('pending'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('idx_add_device_request_code').on(t.codeHash)],
);
