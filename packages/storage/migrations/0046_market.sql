-- 0046 — M8 marketplace (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2). What the marketplace
-- installed (plugins, skills, themes, pets, MCP servers) with where it came from, whether it was
-- verified and the permissions the owner confirmed, and the ratings the owner gave. Ratings stay
-- on the Hub: no rating service exists. All timestamps UTC ISO-8601, ids UUIDv7.

-- One installed item per account, kind and id; an update replaces the row.
CREATE TABLE market_install (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('plugin', 'skill', 'theme', 'pet', 'mcp')),
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  -- `<catalogId>/<id>@<version>`, plus `#<commit>` for an item read from Git.
  origin TEXT NOT NULL,
  signature TEXT NOT NULL CHECK (signature IN ('verified', 'unverified')),
  -- base64url of the Ed25519 key that vouched for it (the catalog's or the bundle's).
  publisher_key TEXT,
  -- SHA-256 of the artifact (a file's bytes, or a folder's canonical digest).
  sha256 TEXT,
  commit_sha TEXT,
  -- The permission lines the owner confirmed (MarketPermissionLine[]).
  permissions_json TEXT NOT NULL DEFAULT '[]',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_market_install_item ON market_install (account_id, kind, item_id);

-- A rating the owner gave an item, 1 to 5 stars with an optional review.
CREATE TABLE market_rating (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('plugin', 'skill', 'theme', 'pet', 'mcp')),
  item_id TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  review TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_market_rating_item ON market_rating (account_id, kind, item_id);
