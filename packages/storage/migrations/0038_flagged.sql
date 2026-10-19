-- 0038 — M7 flagged features (FR-202, FR-203; docs/08 §1.1, docs/10, docs/12 §6.2): scripted tool
-- calls and external agent adapters. Both are off by default (`scripts.enabled`,
-- `externalAgents.enabled`). All timestamps UTC ISO-8601, ids UUIDv7. Thread ids of later areas'
-- tables are not referenced.

-- One `script.run` call. Its id is the tool call's (`tool_call.id`); the nested calls it made are
-- the tool calls whose `parent_call_id` names it. Only the code's hash is kept here, never the
-- code or its output (the tool call row holds the redacted arguments and result).
CREATE TABLE script_run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  thread_id TEXT REFERENCES thread (id),
  turn_id TEXT,
  code_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'cancelled')),
  error_code TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  cpu_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_script_run_thread ON script_run (thread_id, created_at);

-- An external coding agent the owner registered (FR-203): a command that speaks the Agent Client
-- Protocol on stdio. `env_json` values are `secret://` references only. `network_json` lists the
-- hosts its process may reach (its model service), through the egress proxy; none by default.
-- `permission_routing` is the only mode Nova accepts: every file read, write and command goes
-- through Nova's client methods and every permission request to the policy engine.
CREATE TABLE agent_adapter (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',
  network_json TEXT NOT NULL DEFAULT '[]',
  permission_routing TEXT NOT NULL CHECK (permission_routing IN ('client')),
  enabled INTEGER NOT NULL DEFAULT 1,
  -- The last handshake: agent name and version, protocol version, or the reason it was refused.
  last_check_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_agent_adapter_name ON agent_adapter (account_id, name)
  WHERE deleted_at IS NULL;

-- One task a Code session delegated to an adapter. The prompt is the user's; the output is the
-- agent's reply text, redacted and capped. Its file changes are the session's own diffs.
CREATE TABLE agent_delegation (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  thread_id TEXT NOT NULL REFERENCES thread (id),
  adapter_id TEXT NOT NULL REFERENCES agent_adapter (id),
  status TEXT NOT NULL
    CHECK (status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
  prompt TEXT NOT NULL,
  output TEXT,
  stop_reason TEXT,
  error TEXT,
  agent_json TEXT,
  permission_requests INTEGER NOT NULL DEFAULT 0,
  operations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_agent_delegation_thread ON agent_delegation (thread_id, created_at);
