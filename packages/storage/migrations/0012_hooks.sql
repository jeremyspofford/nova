-- 0012 — M4 lifecycle hooks (docs/06 §2 `hook`; docs/08 §4.1; FR-197, ADR-068). One row per hook
-- found in a source (managed policy, the user hooks file, a project folder's .nova/hooks.json, a
-- plugin) with its trust record (contracts/schemas/hook-config.json#/$defs/trustRecord). A hook
-- runs only while trust_state = 'trusted' and trusted_hash = content_hash (docs/06 §6 invariant
-- 13). The hooks files stay authoritative for definitions; the Hub re-reads them and re-hashes.
CREATE TABLE hook (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  -- The hook's id in its file, unique per source.
  hook_key TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'session.start', 'session.end', 'prompt.submit', 'tool.pre', 'permission.request',
    'tool.post', 'compact.pre', 'compact.post', 'subagent.start', 'subagent.stop', 'stop',
    'interrupt'
  )),
  -- JSON glob list; NULL = every occurrence.
  matcher_json TEXT,
  handler_kind TEXT NOT NULL CHECK (handler_kind IN ('command', 'mcp_tool')),
  handler_json TEXT NOT NULL,
  fail_closed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('managed', 'user', 'project', 'plugin', 'extension')),
  plugin_id TEXT,
  project_id TEXT REFERENCES project (id) ON DELETE CASCADE,
  -- The definition as found in its file (what is hashed, without `enabled`).
  definition_json TEXT NOT NULL,
  -- The folder a command hook runs in and whose files it may reference (plugin or project folder).
  base_dir TEXT,
  -- Plugin hooks: the plugin's limits at install ({network, fsProject, answersAsks}).
  limits_json TEXT,
  -- SHA-256 over the canonical definition and any script it runs inside base_dir.
  content_hash TEXT NOT NULL,
  -- The hash the user trusted; NULL or different = needs_trust.
  trusted_hash TEXT,
  trust_state TEXT NOT NULL DEFAULT 'needs_trust'
    CHECK (trust_state IN ('needs_trust', 'trusted', 'revoked')),
  trusted_by TEXT,
  trusted_at TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 600000),
  -- The user's switch (user hooks) or the plugin's (plugin hooks); the file's own `enabled` is
  -- part of definition_json.
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_effect TEXT CHECK (last_effect IS NULL OR last_effect IN
    ('none', 'context', 'decision', 'continue', 'blocked', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- NULLs are distinct in a plain UNIQUE constraint, so the per-source key uses COALESCE.
CREATE UNIQUE INDEX idx_hook_key
  ON hook (account_id, source, COALESCE(plugin_id, ''), COALESCE(project_id, ''), hook_key);
CREATE INDEX idx_hook_event ON hook (account_id, event);
