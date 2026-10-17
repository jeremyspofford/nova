-- 0006 — M3 tool runtime: tool calls and artifacts (docs/06 §2 "tools, approvals, ...",
-- "memory, artifacts, ..."; docs/08 §1; FR-038, FR-099, FR-100). All timestamps UTC ISO-8601,
-- ids UUIDv7.

-- One tool invocation: by the model inside a turn, from the UI, or (later) from a hook or an
-- external MCP client. Arguments and results are stored redacted (FR-101); the full input never
-- reaches the audit log, which keeps only its hash (FR-104).
CREATE TABLE tool_call (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  message_id TEXT REFERENCES message (id),
  thread_id TEXT REFERENCES thread (id),
  turn_id TEXT REFERENCES turn (id),
  -- run_step arrives in M4; a plain column until then.
  run_step_id TEXT,
  parent_call_id TEXT REFERENCES tool_call (id),
  -- The id the model gave the call; tool results go back to the model under it.
  model_call_id TEXT,
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('builtin', 'mcp', 'plugin', 'computer', 'browser', 'page', 'device')),
  server_id TEXT,
  plugin_id TEXT,
  origin TEXT NOT NULL DEFAULT 'model' CHECK (origin IN ('model', 'ui', 'hook', 'mcp_client')),
  args_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'awaiting_approval', 'running', 'ok', 'error', 'denied', 'timeout', 'cancelled')
  ),
  -- The policy decision (allow|deny|handoff) and the approval that resolved an `ask`, if any. The
  -- approval table belongs to the policy area (0007); a plain column keeps the areas independent.
  decision TEXT,
  approval_id TEXT,
  tags_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_call_thread ON tool_call (thread_id, created_at);
CREATE INDEX idx_tool_call_turn ON tool_call (turn_id);
CREATE INDEX idx_tool_call_message ON tool_call (message_id);

-- Structured outputs shown in the artifacts pane (FR-038). The row holds the current version;
-- every version's bytes stay addressable through artifact_version. Bytes are content-addressed
-- blobs under the data directory (docs/06 §3).
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  thread_id TEXT REFERENCES thread (id),
  message_id TEXT REFERENCES message (id),
  run_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN ('markdown', 'code', 'html', 'image', 'svg', 'chart', 'pdf', 'docx', 'pptx', 'xlsx',
             'site', 'canvas', 'file')
  ),
  title TEXT,
  blob_path TEXT,
  mime TEXT,
  sha256 TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  live INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_artifact_thread ON artifact (thread_id, created_at);

CREATE TABLE artifact_version (
  artifact_id TEXT NOT NULL REFERENCES artifact (id),
  version INTEGER NOT NULL,
  message_id TEXT,
  blob_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
