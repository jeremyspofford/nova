-- 0028 — M6.5 Add Device (FR-132, FR-140; docs/22 §4, §9; ADR-094). A pairing is what the owner
-- starts (a short code, single use, 5 minutes); a pairing request is what a new device sends with
-- that code and its Ed25519 public key; the owner approves or denies it on the Hub. Codes are kept
-- only as SHA-256 hashes. A browser or app gets a device session (an `auth_token` of kind
-- `session` tied to its device here); novad and compute nodes get a one-use enrollment token
-- (the 0005 `add_device_request` rows) bound to their key. Revoking a device deletes its sessions
-- and blocks its key. All timestamps UTC ISO-8601, ids UUIDv7.

-- What the owner started. `code_hash` is hex SHA-256 of `nova-add-device-code-v1|<id>|<code>`
-- (the code upper case, without the dash). `attempts` counts wrong codes; the fifth burns it.
CREATE TABLE device_pairing (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  role TEXT NOT NULL CHECK (role IN ('client', 'compute', 'wake-helper')),
  -- JSON array of scope names chosen at add time (docs/22 §4.2).
  scopes TEXT NOT NULL DEFAULT '[]',
  -- The name the owner gave on the Hub; it wins over the name the device reports.
  name TEXT,
  transport TEXT NOT NULL DEFAULT 'direct' CHECK (transport IN ('direct', 'relay')),
  code_hash TEXT NOT NULL,
  -- The Relay's pairing slot (transport relay only).
  relay_pairing_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'expired', 'burned')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_device_pairing_account ON device_pairing (account_id, created_at);
CREATE INDEX idx_device_pairing_open ON device_pairing (status, expires_at);

-- A device's request to join, one per pairing (the unique index makes the code single use).
-- A direct join (v2) starts `committed`: the device sent a commitment to its secret nonce and the
-- Hub answered with its own nonce; the reveal (within 2 minutes) checks the commitment, computes
-- `confirmation` (the 6-digit code both screens show) and makes it `pending` for the owner. A
-- Relay join (v1) is `pending` at once. `last_poll` is the newest accepted status poll time (Unix
-- seconds): a poll must be newer, so a captured poll cannot be replayed.
CREATE TABLE device_pairing_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  pairing_id TEXT NOT NULL REFERENCES device_pairing (id),
  role TEXT NOT NULL CHECK (role IN ('client', 'compute', 'wake-helper')),
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'novad', 'compute', 'native')),
  scopes TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  -- Raw Ed25519 public key (base64url) and its SHA-256 (hex, as `device.cert_fingerprint`).
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  -- Null until the reveal (v2).
  confirmation TEXT,
  -- v2: base64url SHA-256 of `nova-add-device-commit-v1|<public key>|<device nonce>`, the Hub's
  -- nonce, and when the device revealed its own (once).
  commitment TEXT,
  hub_nonce TEXT,
  revealed_at TEXT,
  via TEXT NOT NULL DEFAULT 'direct' CHECK (via IN ('direct', 'relay')),
  relay_client_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('committed', 'pending', 'approved', 'denied', 'expired')),
  -- The device record approval created (pending until novad or a compute node registers).
  device_id TEXT REFERENCES device (id),
  last_poll INTEGER,
  -- What the first approved poll handed out (never the secret itself).
  grant_type TEXT CHECK (grant_type IN ('session', 'novad', 'compute')),
  granted_at TEXT,
  decided_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_device_pairing_request_pairing ON device_pairing_request (pairing_id);
CREATE INDEX idx_device_pairing_request_account
  ON device_pairing_request (account_id, status, created_at);
CREATE INDEX idx_device_pairing_request_device ON device_pairing_request (device_id);

-- A browser's or app's session belongs to its device and is deleted when the device is revoked.
CREATE TABLE device_session (
  token_id TEXT PRIMARY KEY REFERENCES auth_token (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  request_id TEXT REFERENCES device_pairing_request (id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_device_session_device ON device_session (device_id);

-- Keys of revoked devices (docs/22 §4.5): a later Add Device with one of them is refused.
-- `device_id` is a plain column so the row outlives any purge of the device.
CREATE TABLE revoked_device_key (
  fingerprint TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
