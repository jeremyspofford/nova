-- 0032 — M6.5 Relay (FR-137; docs/22 §3, contracts/rest-api.md §3; ADR-071, ADR-094). The Hub's
-- registration at a Relay and the clients paired through it. The route token and the Hub's X25519
-- private key are vault entries (`secret://relay/<registration id>/route-token`, `.../x25519`);
-- rows hold only their references. Device, Add Device pairing and request ids are plain columns:
-- those rows belong to the add-device area, and a client pairs before its device record exists.
-- All timestamps UTC ISO-8601.

-- One row per Relay this Hub registered with; `route_id` is the Hub's routing id there. A Relay
-- that no longer knows the Hub's token makes it `rejected`; a changed Relay URL `retired`.
CREATE TABLE relay_registration (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  route_id TEXT NOT NULL,
  token_ref TEXT NOT NULL,
  x25519_key_ref TEXT NOT NULL,
  x25519_public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rejected', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_relay_registration_url ON relay_registration (url, status);

-- A client paired through the Relay (`id` is its relay client id, `route_id` its routing id).
-- `pending` until the owner approves the Add Device request, then `active`; `denied` (the owner
-- said no, or the claim was refused) and `expired` (nobody decided in time) keep their rows; only a
-- `revoked` client's key is refused when it pairs again (docs/22 §4.5). `stream_floor` is the highest client
-- stream counter accepted (docs/22 §9.9): it survives restarts, so a replayed old stream stays
-- refused.
CREATE TABLE relay_client (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  registration_id TEXT NOT NULL REFERENCES relay_registration (id),
  route_id TEXT NOT NULL,
  relay_pairing_id TEXT NOT NULL,
  add_pairing_id TEXT,
  request_id TEXT,
  device_id TEXT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'native')),
  -- Raw Ed25519 device key and X25519 Relay key, base64url.
  public_key TEXT NOT NULL,
  x25519_public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'denied', 'expired', 'revoked')),
  stream_floor INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_relay_client_route ON relay_client (registration_id, route_id);
CREATE INDEX idx_relay_client_account ON relay_client (account_id, status);
CREATE INDEX idx_relay_client_key ON relay_client (public_key);
CREATE INDEX idx_relay_client_request ON relay_client (request_id);
