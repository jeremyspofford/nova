-- 0001 — foundation tables (M0). Mirrors docs/06; all timestamps UTC ISO-8601, ids UUIDv7.

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'oidc')),
  display_name TEXT,
  username TEXT,
  avatar_path TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Settings are scoped; precedence is resolved in code (docs/14 §1).
CREATE TABLE setting (
  key TEXT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'global' CHECK (scope_kind IN ('global', 'project', 'device')),
  scope_ref TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, scope_kind, scope_ref)
);

-- Persisted events (contracts/events.md). Ephemeral events are never stored.
CREATE TABLE event (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  ts TEXT NOT NULL,
  account_id TEXT,
  actor TEXT NOT NULL,
  correlation_json TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_event_ts ON event (ts);
CREATE INDEX idx_event_name ON event (name, ts);

-- Feature flags with lifecycle stages (ADR-082).
CREATE TABLE feature_flag (
  key TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('experimental', 'beta', 'stable', 'deprecated', 'removed')),
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Bearer credentials for every listener (FR-192). Only hashes are stored.
CREATE TABLE auth_token (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'session', 'device', 'mcp_client', 'app')),
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT REFERENCES account (id),
  label TEXT,
  scopes TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
