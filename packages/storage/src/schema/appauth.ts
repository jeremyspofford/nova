// M8 third-party app authorization (migration 0049_appauth.sql; FR-222, ADR-097 D6): registered
// clients, the link from an app authorization (kind `app`, 0013) to its client, authorization
// codes and tokens. Codes and tokens are SHA-256 hashes only. SQL migrations are authoritative;
// test/schema.test.ts checks them.
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { appAuthorization } from './apps.ts';
import { account } from './core.ts';

/** An app that registered itself (RFC 7591, public client). */
export const appClient = sqliteTable(
  'app_client',
  {
    /** The public client_id. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** JSON array of redirect URIs. */
    redirectUris: text('redirect_uris').notNull(),
    /** JSON array of the scopes it may ask for. */
    scopes: text('scopes').notNull(),
    createdAt: text('created_at').notNull(),
    approvedAt: text('approved_at'),
  },
  (t) => [index('idx_app_client_pending').on(t.approvedAt, t.createdAt)],
);

/** Which client an app authorization of kind `app` belongs to. */
export const appConsent = sqliteTable(
  'app_consent',
  {
    authorizationId: text('authorization_id')
      .primaryKey()
      .references(() => appAuthorization.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    clientId: text('client_id')
      .notNull()
      .references(() => appClient.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_app_consent_client').on(t.accountId, t.clientId)],
);

/** An authorization code (one use, 5 minutes, PKCE S256). */
export const appCode = sqliteTable(
  'app_code',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => appClient.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    authorizationId: text('authorization_id')
      .notNull()
      .references(() => appAuthorization.id),
    redirectUri: text('redirect_uri').notNull(),
    /** JSON array of the granted scopes. */
    scopes: text('scopes').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    familyId: text('family_id'),
  },
  (t) => [index('idx_app_code_expires').on(t.expiresAt)],
);

/** An access or refresh token (`nva_…`), as its hash. */
export const appToken = sqliteTable(
  'app_token',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: text('family_id').notNull(),
    authorizationId: text('authorization_id')
      .notNull()
      .references(() => appAuthorization.id),
    clientId: text('client_id')
      .notNull()
      .references(() => appClient.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    /** JSON array of scopes. */
    scopes: text('scopes').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    index('idx_app_token_family').on(t.familyId),
    index('idx_app_token_authorization').on(t.authorizationId, t.revokedAt),
    index('idx_app_token_expires').on(t.expiresAt),
  ],
);
