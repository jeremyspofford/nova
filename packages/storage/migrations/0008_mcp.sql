-- 0008 — M3 MCP client servers (docs/06 §2 "extensions, settings, sync"; docs/08 §2.1, §2.3;
-- FR-042, FR-043). Secret values never live here: `env_ref_json` and the header references in
-- `config_json` hold `secret://mcp/<id>/…` references into the vault (FR-101).

CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  -- Unique per account; the namespace segment of the server's tools (`mcp:<name>.<tool>`).
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
  command TEXT,
  args_json TEXT,
  url TEXT,
  -- {"NAME": "secret://…"}: environment variable names and their vault references.
  env_ref_json TEXT,
  -- contracts/schemas/mcp-config.json#/$defs/server fields not in columns: timeouts, tool lists,
  -- defaultApproval, header references.
  config_json TEXT,
  source TEXT NOT NULL DEFAULT 'user'
    CHECK (source IN ('user', 'plugin', 'bundle', 'import', 'managed', 'device')),
  plugin_id TEXT,
  -- A device-local stdio server reached through novad (FR-210, M6).
  device_id TEXT REFERENCES device (id),
  -- MCP bundle install record (FR-199, M5).
  bundle_manifest_json TEXT,
  signature_status TEXT CHECK (signature_status IN ('verified', 'unverified')),
  bundle_sha256 TEXT,
  install_record_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- The last reported status and error (FR-043); the live status comes from the connection.
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_mcp_server_name ON mcp_server (account_id, name);
