// M6.5 Relay tables (migration 0032_relay.sql; FR-137, docs/22 §3, ADR-094). SQL migrations are
// authoritative; test/schema.test.ts checks them. The route token and the X25519 private key live
// in the vault; rows hold only their `secret://` references.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

export const relayRegistration = sqliteTable(
  'relay_registration',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    /** The Hub's routing id at this Relay. */
    routeId: text('route_id').notNull(),
    /** `secret://relay/<id>/route-token`. */
    tokenRef: text('token_ref').notNull(),
    /** `secret://relay/<id>/x25519` (PKCS#8, base64url). */
    x25519KeyRef: text('x25519_key_ref').notNull(),
    x25519PublicKey: text('x25519_public_key').notNull(),
    status: text('status', { enum: ['active', 'rejected', 'retired'] })
      .notNull()
      .default('active'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_relay_registration_url').on(t.url, t.status)],
);

export const relayClient = sqliteTable(
  'relay_client',
  {
    /** The relay client id the Relay issued. */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    registrationId: text('registration_id')
      .notNull()
      .references(() => relayRegistration.id),
    routeId: text('route_id').notNull(),
    relayPairingId: text('relay_pairing_id').notNull(),
    /** Add Device pairing, request and device ids (plain: the add-device area's rows). */
    addPairingId: text('add_pairing_id'),
    requestId: text('request_id'),
    deviceId: text('device_id'),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    kind: text('kind', { enum: ['browser', 'native'] }).notNull(),
    publicKey: text('public_key').notNull(),
    x25519PublicKey: text('x25519_public_key').notNull(),
    status: text('status', { enum: ['pending', 'active', 'denied', 'expired', 'revoked'] })
      .notNull()
      .default('pending'),
    /** The highest client stream counter accepted (replay guard across restarts). */
    streamFloor: integer('stream_floor').notNull().default(0),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    uniqueIndex('idx_relay_client_route').on(t.registrationId, t.routeId),
    index('idx_relay_client_account').on(t.accountId, t.status),
    index('idx_relay_client_key').on(t.publicKey),
    index('idx_relay_client_request').on(t.requestId),
  ],
);
