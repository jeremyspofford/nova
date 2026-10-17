-- 0013 — M4 app authorizations for Nova's MCP server and OAuth for remote MCP servers (docs/06 §2
-- "extensions, settings, sync"; docs/08 §2.1-§2.2, §2.5; FR-044, FR-047, FR-192, FR-199). Tokens
-- never live here: a client token is stored only as its SHA-256 hash, and OAuth access and refresh
-- tokens are `secret://mcp/<server id>/oauth/…` references into the vault (FR-101). MCP bundle
-- installs use the bundle columns of `mcp_server` (0008).

-- One per external client allowed to use Nova's MCP server (`mcp_client`), later third-party apps
-- (`app`, FR-222). `scopes` is AppAuthorizationView.scopes as JSON: tools, projects, thread scope
-- and mode. Revoked rows stay for the audit trail and are not listed.
CREATE TABLE app_authorization (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('mcp_client', 'app')),
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  CHECK (status <> 'active' OR token_hash IS NOT NULL)
);
CREATE INDEX idx_app_authorization_account ON app_authorization (account_id, status);

-- OAuth 2.1 (PKCE) for one sse/http MCP server: where its authorization server is, how Nova is
-- registered there, and the token state. Removing the server removes this row.
CREATE TABLE mcp_oauth (
  server_id TEXT PRIMARY KEY REFERENCES mcp_server (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  -- The authorization server (issuer) and its RFC 8414 metadata.
  issuer TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  -- RFC 8707 resource indicator from the server's protected-resource metadata.
  resource TEXT,
  client_id TEXT NOT NULL,
  -- Set when dynamic registration returned a client secret (vault reference).
  client_secret_ref TEXT,
  registration TEXT NOT NULL CHECK (registration IN ('metadata_document', 'dynamic')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  access_token_ref TEXT,
  refresh_token_ref TEXT,
  status TEXT NOT NULL DEFAULT 'needs_auth'
    CHECK (status IN ('needs_auth', 'connected', 'expired', 'error')),
  expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
