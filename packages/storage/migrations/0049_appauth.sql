-- 0049 — M8 third-party app authorization (FR-222; ADR-097 D6). OAuth 2.0 authorization code with
-- PKCE (S256 only) for public clients. A registered app is an `app_client`; the owner's approval
-- is an `app_authorization` row of kind `app` (0013: the table Settings already lists and
-- revokes, with `app.authorization.changed`) linked to its client by `app_consent`; codes and
-- tokens are their own rows. Codes and tokens are stored only as SHA-256 hashes; nothing secret
-- lives here. Timestamps are UTC ISO-8601.

-- An app that registered itself (RFC 7591, public client: no secret). Registration is public and
-- rate-limited; a client nobody approved within a day is removed.
CREATE TABLE app_client (
  -- The public client_id.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- JSON array: loopback http://127.0.0.1 or http://[::1] URIs, or private-use schemes.
  redirect_uris TEXT NOT NULL,
  -- JSON array of the scopes it may ask for.
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The first time an account approved it.
  approved_at TEXT
);
CREATE INDEX idx_app_client_pending ON app_client (approved_at, created_at);

-- Which client an app authorization (kind `app`) belongs to. The authorization's `scopes` holds
-- the granted scopes (MCP-shaped for the M4 list, plus `app`: the scope names).
CREATE TABLE app_consent (
  authorization_id TEXT PRIMARY KEY REFERENCES app_authorization (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  client_id TEXT NOT NULL REFERENCES app_client (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_app_consent_client ON app_consent (account_id, client_id);

-- An authorization code: one use, 5 minutes, bound to its client, redirect URI and PKCE
-- challenge. A second use revokes the token chain the first one started (`family_id`).
CREATE TABLE app_code (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES app_client (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  authorization_id TEXT NOT NULL REFERENCES app_authorization (id),
  redirect_uri TEXT NOT NULL,
  -- JSON array of the scopes this request granted.
  scopes TEXT NOT NULL,
  -- BASE64URL(SHA-256(code_verifier)) (RFC 7636 S256).
  code_challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  family_id TEXT
);
CREATE INDEX idx_app_code_expires ON app_code (expires_at);

-- Access (1 hour) and refresh (30 days) tokens, `nva_…`. A refresh token is used once: using it
-- issues a new pair in the same family; presenting a used one again revokes the whole family.
CREATE TABLE app_token (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL REFERENCES app_authorization (id),
  client_id TEXT NOT NULL REFERENCES app_client (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  -- JSON array; a call is also limited by the authorization's current scopes.
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_app_token_family ON app_token (family_id);
CREATE INDEX idx_app_token_authorization ON app_token (authorization_id, revoked_at);
CREATE INDEX idx_app_token_expires ON app_token (expires_at);
