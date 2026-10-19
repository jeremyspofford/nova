-- 0045 — M8 extension SDK (FR-117; docs/14 §4, docs/26 §3; ADR-097 D2-D3). An extension is a
-- plugin (`plugin_install`, 0011) whose folder also holds `.nova-plugin/extension.json`; this table
-- keeps what the plugin row cannot: the bundle's digest and how its signature checked out, the
-- publisher's key and the validated extension.json. Its worker's state is not stored (it is
-- runtime), only the last error. Secrets an extension declares live in the vault under
-- `secret://extension/<plugin_id>/<name>`; rows never hold a value. All timestamps UTC ISO-8601,
-- ids UUIDv7.
CREATE TABLE extension_install (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  -- The plugin id (reverse-DNS); the extension's tools are `ext:<plugin_id>/<name>`.
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  -- extension.json `api` (1 in M8).
  api INTEGER NOT NULL,
  -- verified (a trusted publisher signed it), unverified (unsigned or an unknown key, installed
  -- through the sideload confirmation) or dev (loaded by `nova dev`, always unverified).
  signature TEXT NOT NULL CHECK (signature IN ('verified', 'unverified', 'dev')),
  -- base64url of the raw Ed25519 key whose signature verified; null when unsigned.
  publisher_key TEXT,
  -- D2 digest of the bundle's files (lower-case hex SHA-256); SDK hook hashes cover it.
  digest TEXT NOT NULL,
  -- The validated `.nova-plugin/extension.json`; its `permissions` is what the owner confirmed.
  manifest_json TEXT NOT NULL,
  -- Why the worker last failed (start, crash, limits); null once it runs again.
  last_error TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_extension_install_plugin ON extension_install (account_id, plugin_id);
