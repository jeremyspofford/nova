-- 0011 — M4 plugins, skills and sub-agent roles (docs/06 §2 "extensions, settings, sync";
-- docs/08 §3-§4; FR-045, FR-046). All timestamps UTC ISO-8601, ids UUIDv7. A plugin's MCP
-- servers are `mcp_server` rows with source 'plugin' (0008); its hooks belong to the hooks area.

-- One installed plugin per account. The plugin itself lives on disk in
-- `<dataDir>/plugins/<plugin_id>/<version>/`; an update replaces the row and the folder.
CREATE TABLE plugin_install (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  -- The manifest id (reverse-DNS, plugin-manifest.json `id`).
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'catalog', 'git')),
  -- A folder, `<catalogId>/<pluginId>` or a Git URL with the commit it was cloned at.
  origin TEXT NOT NULL,
  -- The validated .nova-plugin/plugin.json; `permissions` in it is what the user confirmed.
  manifest_json TEXT NOT NULL,
  -- verified|unverified (signatures arrive with the marketplace, FR-049).
  signature TEXT NOT NULL DEFAULT 'unverified' CHECK (signature IN ('verified', 'unverified')),
  install_path TEXT NOT NULL,
  -- What the install registered: MCP server ids by manifest key, skills, commands, roles, hooks.
  registrations_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_plugin_install_plugin ON plugin_install (account_id, plugin_id);

-- Skills are discovered from their folders (SKILL.md stays on disk, ADR-067); this table keeps
-- only what the folders cannot: the user's enabled switch and import provenance (FR-200).
-- `skill_id` is the canonical `skill:<source or pluginId>:<name>` id.
CREATE TABLE skill_state (
  account_id TEXT NOT NULL REFERENCES account (id),
  skill_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- 'import' for user-folder skills an import created (shown with source 'import').
  origin TEXT CHECK (origin IS NULL OR origin IN ('import')),
  provenance_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, skill_id)
);

-- Sub-agent roles a plugin brings (docs/08 §3.1): `role:<pluginId>:<name>`, used by task.spawn
-- in M5. A role's tools never exceed the plugin's permissions or the parent run's (docs/09 §4).
CREATE TABLE agent_role (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  role_key TEXT NOT NULL,
  plugin_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  model_hint TEXT,
  instructions TEXT NOT NULL,
  source_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_agent_role_key ON agent_role (account_id, role_key);
CREATE INDEX idx_agent_role_plugin ON agent_role (account_id, plugin_id);
