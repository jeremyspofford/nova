-- 0022 — M6 computers and the egress proxy (FR-080, FR-102, FR-107, FR-193; docs/06 "agents &
-- computers", docs/11, docs/12 §8, ADR-063). All timestamps UTC ISO-8601, ids UUIDv7.

-- A computer: an agent's own (cloud, or a sandbox on the Hub) or a connected device. Files live
-- under <dataDir>/computers/<id>/ (home, browser profile); `agent_id` is set for an agent's own
-- computer (at most one per agent, docs/06 invariant 6) and `device_id` for `local_host`.
CREATE TABLE computer (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('cloud', 'local_container', 'local_host')),
  agent_id TEXT REFERENCES agent (id) ON DELETE CASCADE,
  -- Who serves it: container, bwrap, micro_vm, mock_cloud, novad.
  provider TEXT,
  base_image TEXT,
  state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (state IN ('starting', 'running', 'stopped', 'degraded', 'error')),
  device_id TEXT REFERENCES device (id),
  -- The latest snapshot's folder.
  snapshot_blob_path TEXT,
  spec_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_computer_account ON computer (account_id, created_at);
CREATE UNIQUE INDEX uq_computer_agent ON computer (agent_id)
  WHERE agent_id IS NOT NULL AND kind <> 'local_host';

-- A snapshot of a computer's files: a copy under blobs/snapshots/<computer-id>/<snapshot-id>/.
CREATE TABLE computer_snapshot (
  id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
  label TEXT,
  blob_path TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_computer_snapshot ON computer_snapshot (computer_id, created_at DESC);

-- A scope's network policy (docs/11 §7, Settings > Network): it narrows the global mode and adds
-- allow and deny entries and stripping hooks. Scope ids are plain TEXT (run, Code session,
-- agent, plugin or MCP server). `mode` NULL inherits the global mode.
CREATE TABLE egress_scope (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('run', 'session', 'agent', 'plugin', 'mcp_server')),
  scope_id TEXT NOT NULL,
  mode TEXT CHECK (mode IS NULL OR mode IN ('off', 'allowlist', 'limited')),
  allow_json TEXT NOT NULL DEFAULT '[]',
  deny_json TEXT NOT NULL DEFAULT '[]',
  hooks_json TEXT NOT NULL DEFAULT '[]',
  allow_local_binding INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_egress_scope ON egress_scope (account_id, scope_kind, scope_id);

-- A credential the proxy injects for its hosts (ADR-063). The value is in the vault
-- (`secret_ref`), never here; a scope limits it to one run, session or agent.
CREATE TABLE egress_credential (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL,
  hosts_json TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('bearer', 'basic', 'header')),
  header_name TEXT,
  username TEXT,
  scope_kind TEXT CHECK (scope_kind IS NULL OR scope_kind IN ('run', 'session', 'agent', 'plugin', 'mcp_server')),
  scope_id TEXT,
  secret_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (scheme <> 'header' OR header_name IS NOT NULL),
  CHECK ((scope_kind IS NULL) = (scope_id IS NULL))
);
CREATE INDEX idx_egress_credential_account ON egress_credential (account_id, created_at);
