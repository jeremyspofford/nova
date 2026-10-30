-- The device mesh (M4a): the registry, pairing codes, join requests, device sessions, and this
-- node's place in the mesh. Keys held here are public halves only; the hub's own private keys live
-- in home/mesh/identity.json and never in the database.

-- Every device that was ever approved, the hub included. A public key appears once: a revoked key
-- can never enroll again, so a device that wants back in needs a new key.
CREATE TABLE device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'phone', 'computer', 'standby')),
  role TEXT NOT NULL CHECK (role IN ('client', 'spoke', 'standby', 'hub')),
  public_key TEXT NOT NULL UNIQUE,
  x25519_public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  trust TEXT NOT NULL CHECK (trust IN ('trusted', 'revoked')),
  can_approve INTEGER NOT NULL DEFAULT 0 CHECK (can_approve IN (0, 1)),
  address TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  last_seen TEXT
);

-- One code. Only a hash of it, salted with the id, is kept; it works once, until expires_at.
CREATE TABLE pairing (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX pairing_open ON pairing (expires_at) WHERE used_at IS NULL;

-- One device asking to join with a code. The confirmation exists once the device has revealed its
-- nonce; only then can the person approve. last_time is the newest signed time accepted from the
-- device, so a captured poll or reveal can't be replayed.
CREATE TABLE join_request (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairing (id),
  public_key TEXT NOT NULL,
  x25519_public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'phone', 'computer', 'standby')),
  capabilities TEXT NOT NULL DEFAULT '[]',
  address TEXT,
  commitment TEXT NOT NULL,
  hub_nonce TEXT NOT NULL,
  device_nonce TEXT,
  confirmation TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  reason TEXT,
  last_time INTEGER NOT NULL DEFAULT 0,
  device_id TEXT REFERENCES device (id),
  created_at TEXT NOT NULL,
  revealed_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX join_request_state ON join_request (state, expires_at);

-- A device's sessions: only a SHA-256 of each token is kept.
CREATE TABLE device_session (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX device_session_device ON device_session (device_id);

-- This node's place in the mesh: one row. The epoch goes up by one at every promotion.
CREATE TABLE mesh_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('hub', 'standby')),
  hub_id TEXT,
  standby_id TEXT,
  updated_at TEXT NOT NULL
);
