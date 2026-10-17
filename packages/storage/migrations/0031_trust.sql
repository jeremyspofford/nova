-- 0031 — M6.5 trust (FR-134, docs/22 §5): the Hub identity's public key, the Hub local CA's public
-- certificate and every certificate the Hub issued or stores: its own TLS leaf, device certificates for Add Device, and
-- certificates from the mesh. Private keys are never stored here: the CA's and the Hub's TLS keys
-- are vault entries (`key_ref`, a secret:// reference); a device keeps its own key. All timestamps
-- UTC ISO-8601, ids UUIDv7. `device_id` is a plain column with no foreign key: a device certificate
-- may name a novad device or a compute node, which live in different tables.

-- The Hub identity key's public half (FR-134). The private key is the vault entry `key_ref`; if
-- it is ever missing or different, the Hub refuses to use another one instead of making a new
-- identity that every pinned device would reject. One row.
CREATE TABLE trust_identity (
  id TEXT PRIMARY KEY CHECK (id = 'hub'),
  -- base64url of the raw 32-byte Ed25519 public key.
  public_key TEXT NOT NULL,
  -- base64url(SHA-256(public key)): what devices pin.
  fingerprint TEXT NOT NULL,
  key_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The Hub local CA. One is active (`retired_at` NULL); only the owner replaces it, never the Hub
-- on its own. A retired CA's key leaves the vault (`key_ref` NULL then).
CREATE TABLE trust_ca (
  id TEXT PRIMARY KEY,
  cert_pem TEXT NOT NULL,
  -- SHA-256 of the certificate's DER, upper-case hex with colons.
  fingerprint TEXT NOT NULL,
  key_ref TEXT,
  -- What the CA may sign: {"dns": [...], "ip": [...]} (RFC 5280 name constraints).
  name_constraints_json TEXT NOT NULL,
  not_before TEXT NOT NULL,
  not_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE UNIQUE INDEX idx_trust_ca_active ON trust_ca ((retired_at IS NULL)) WHERE retired_at IS NULL;

-- Issued and stored certificates. The revocation list is the rows with `revoked_at` set; whatever
-- verifies a device certificate checks its row here.
CREATE TABLE trust_certificate (
  id TEXT PRIMARY KEY,
  -- The issuing local CA; NULL for a mesh certificate (the mesh's CA issued it).
  ca_id TEXT REFERENCES trust_ca (id),
  kind TEXT NOT NULL CHECK (kind IN ('hub_tls', 'device', 'mesh')),
  -- Lower-case hex.
  serial TEXT NOT NULL,
  subject TEXT NOT NULL,
  device_id TEXT,
  role TEXT,
  sans_json TEXT NOT NULL DEFAULT '[]',
  -- A device certificate's key as the device sent it (base64url of the raw Ed25519 key).
  public_key TEXT,
  cert_pem TEXT NOT NULL,
  -- The Hub's own TLS keys (hub_tls, mesh) in the vault; NULL for device certificates and once a
  -- superseded certificate's key left the vault.
  key_ref TEXT,
  not_before TEXT NOT NULL,
  not_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- A Hub TLS or mesh certificate a renewal replaced.
  superseded_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE UNIQUE INDEX idx_trust_certificate_serial ON trust_certificate (ca_id, serial);
CREATE INDEX idx_trust_certificate_device ON trust_certificate (device_id)
  WHERE device_id IS NOT NULL;
CREATE INDEX idx_trust_certificate_kind ON trust_certificate (kind, created_at);
