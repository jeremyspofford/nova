-- 0005 — compute nodes (M2; FR-126, FR-127, ADR-089). The device tables of docs/06 §7, used for
-- compute nodes until novad devices arrive (M6). Node credentials and enrollment tokens are stored
-- only as hashes; a node's job token lives in the vault at secret://devices/<id>/job-token.

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hub', 'compute', 'client', 'wake-helper')),
  platform TEXT,
  -- SHA-256 of the public key until certificates exist; unique, so a revoked key stays burned.
  cert_fingerprint TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  roles TEXT NOT NULL,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked', 'unreachable')),
  novad_version TEXT,
  relay_client_id TEXT UNIQUE,
  relay_route_id TEXT UNIQUE,
  offline_replica INTEGER NOT NULL DEFAULT 0,
  local_runtime INTEGER NOT NULL DEFAULT 0,
  -- The node credential (auth_token kind 'device'); cleared and deleted on revoke.
  credential_token_id TEXT REFERENCES auth_token (id),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_device_account ON device (account_id, kind, status);
CREATE INDEX idx_device_credential ON device (credential_token_id);

-- The signed capability document (contracts/schemas/device-capability.json).
CREATE TABLE device_capability (
  device_id TEXT PRIMARY KEY REFERENCES device (id),
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE transport_endpoint (
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES device (id),
  net TEXT NOT NULL CHECK (net IN ('lan', 'mesh', 'relay', 'direct')),
  url TEXT NOT NULL,
  healthy INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER,
  last_checked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_transport_endpoint_device ON transport_endpoint (device_id);

-- One-use enrollment tokens (M2: role compute, 15 min). Only the hash is stored.
CREATE TABLE add_device_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  role TEXT NOT NULL CHECK (role IN ('client', 'compute', 'wake-helper')),
  code_hash TEXT NOT NULL,
  scopes TEXT,
  via TEXT NOT NULL DEFAULT 'direct' CHECK (via IN ('direct', 'relay')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'expired', 'denied')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_add_device_request_code ON add_device_request (code_hash);
