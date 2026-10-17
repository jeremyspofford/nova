// M6.5 Add Device tables (migration 0028_add_device.sql; FR-132, FR-140, docs/22 §4). SQL
// migrations are authoritative; test/schema.test.ts checks them. Codes are stored only as hashes.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account, authToken } from './core.ts';
import { device } from './nodes.ts';

export const devicePairing = sqliteTable(
  'device_pairing',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    role: text('role', { enum: ['client', 'compute', 'wake-helper'] }).notNull(),
    /** JSON array of scope names. */
    scopes: text('scopes').notNull().default('[]'),
    name: text('name'),
    transport: text('transport', { enum: ['direct', 'relay'] })
      .notNull()
      .default('direct'),
    /** Hex SHA-256 of `nova-add-device-code-v1|<id>|<code>`; the code is never stored. */
    codeHash: text('code_hash').notNull(),
    relayPairingId: text('relay_pairing_id'),
    attempts: integer('attempts').notNull().default(0),
    status: text('status', { enum: ['open', 'used', 'expired', 'burned'] })
      .notNull()
      .default('open'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    usedAt: text('used_at'),
  },
  (t) => [
    index('idx_device_pairing_account').on(t.accountId, t.createdAt),
    index('idx_device_pairing_open').on(t.status, t.expiresAt),
  ],
);

export const devicePairingRequest = sqliteTable(
  'device_pairing_request',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    pairingId: text('pairing_id')
      .notNull()
      .references(() => devicePairing.id),
    role: text('role', { enum: ['client', 'compute', 'wake-helper'] }).notNull(),
    kind: text('kind', { enum: ['browser', 'novad', 'compute', 'native'] }).notNull(),
    scopes: text('scopes').notNull().default('[]'),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    publicKey: text('public_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    /** Null until the reveal (v2). */
    confirmation: text('confirmation'),
    /** v2: base64url SHA-256 of `nova-add-device-commit-v1|<publicKey>|<deviceNonce>`. */
    commitment: text('commitment'),
    hubNonce: text('hub_nonce'),
    revealedAt: text('revealed_at'),
    via: text('via', { enum: ['direct', 'relay'] })
      .notNull()
      .default('direct'),
    relayClientId: text('relay_client_id'),
    status: text('status', { enum: ['committed', 'pending', 'approved', 'denied', 'expired'] })
      .notNull()
      .default('pending'),
    deviceId: text('device_id').references(() => device.id),
    /** Newest accepted status poll time (Unix seconds). */
    lastPoll: integer('last_poll'),
    grantType: text('grant_type', { enum: ['session', 'novad', 'compute'] }),
    grantedAt: text('granted_at'),
    decidedAt: text('decided_at'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_device_pairing_request_pairing').on(t.pairingId),
    index('idx_device_pairing_request_account').on(t.accountId, t.status, t.createdAt),
    index('idx_device_pairing_request_device').on(t.deviceId),
  ],
);

export const deviceSession = sqliteTable(
  'device_session',
  {
    tokenId: text('token_id')
      .primaryKey()
      .references(() => authToken.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    requestId: text('request_id').references(() => devicePairingRequest.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_device_session_device').on(t.deviceId)],
);

export const revokedDeviceKey = sqliteTable('revoked_device_key', {
  fingerprint: text('fingerprint').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => account.id),
  deviceId: text('device_id'),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull(),
});
