// M6.5 trust tables (migration 0031_trust.sql; FR-134, docs/22 §5): the Hub identity's public
// key, the Hub local CA's public certificate and the certificates the Hub issued or stores. SQL
// migrations are authoritative; test/schema.test.ts checks them. Private keys are never here:
// `keyRef` is a secret:// reference. `deviceId` is a plain column (a novad device or a compute
// node).
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** The Hub identity key's public half; the private key is the vault entry `keyRef`. One row. */
export const trustIdentity = sqliteTable('trust_identity', {
  id: text('id').primaryKey(),
  /** base64url of the raw 32-byte Ed25519 public key. */
  publicKey: text('public_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  keyRef: text('key_ref').notNull(),
  createdAt: text('created_at').notNull(),
});

/** The Hub local CA; one is active (`retiredAt` null). A retired CA's `keyRef` is null. */
export const trustCa = sqliteTable('trust_ca', {
  id: text('id').primaryKey(),
  certPem: text('cert_pem').notNull(),
  /** SHA-256 of the DER, upper-case hex with colons. */
  fingerprint: text('fingerprint').notNull(),
  keyRef: text('key_ref'),
  /** JSON `{dns: string[], ip: string[]}`. */
  nameConstraintsJson: text('name_constraints_json').notNull(),
  notBefore: text('not_before').notNull(),
  notAfter: text('not_after').notNull(),
  createdAt: text('created_at').notNull(),
  retiredAt: text('retired_at'),
});

/** Issued and stored certificates; revoked ones have `revokedAt`. */
export const trustCertificate = sqliteTable(
  'trust_certificate',
  {
    id: text('id').primaryKey(),
    caId: text('ca_id').references(() => trustCa.id),
    kind: text('kind', { enum: ['hub_tls', 'device', 'mesh'] }).notNull(),
    /** Lower-case hex. */
    serial: text('serial').notNull(),
    subject: text('subject').notNull(),
    deviceId: text('device_id'),
    role: text('role'),
    /** JSON array of names. */
    sansJson: text('sans_json').notNull().default('[]'),
    /** base64url raw Ed25519 key of a device certificate. */
    publicKey: text('public_key'),
    certPem: text('cert_pem').notNull(),
    keyRef: text('key_ref'),
    notBefore: text('not_before').notNull(),
    notAfter: text('not_after').notNull(),
    createdAt: text('created_at').notNull(),
    supersededAt: text('superseded_at'),
    revokedAt: text('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('idx_trust_certificate_serial').on(t.caId, t.serial),
    index('idx_trust_certificate_device').on(t.deviceId),
    index('idx_trust_certificate_kind').on(t.kind, t.createdAt),
  ],
);
