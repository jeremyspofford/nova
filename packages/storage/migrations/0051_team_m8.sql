-- 0051 — M8 team and flagged carry-ins (FR-217 decision 5 of ADR-095, FR-202; ADR-097): a
-- removed member's data is purged after the owner's grace period or at once on request, and a
-- tool call made by a script records the `script` origin. All timestamps UTC ISO-8601.

-- One purge of a removed member's data and its outcome. The account row (its personal fields
-- cleared) and the member's `team_member` row stay, because the audit trail names the account;
-- everything else the account owned goes. A failed purge is tried again by the next sweep. The
-- rows go in one transaction that also records what is left to remove outside the database
-- (`cleanup_json`: blobs, vault entries, folders; status `cleaning`), so a crash between the
-- commit and that cleanup is finished by the next sweep.
CREATE TABLE member_purge (
  account_id TEXT PRIMARY KEY REFERENCES account (id),
  status TEXT NOT NULL CHECK (status IN ('cleaning', 'purged', 'failed')),
  cause TEXT NOT NULL CHECK (cause IN ('grace', 'request')),
  requested_by TEXT REFERENCES account (id),
  attempted_at TEXT NOT NULL,
  purged_at TEXT,
  counts_json TEXT,
  cleanup_json TEXT,
  error TEXT
);
CREATE INDEX idx_member_purge_status ON member_purge (status, attempted_at);

-- `tool_call.origin` gains `script` (docs/08 §1.5): the nested calls of `script.run` record it.
-- SQLite cannot change a CHECK constraint, so the table is rebuilt. Nothing else references it
-- by foreign key; its own `parent_call_id` names the new table, which the rename turns back into
-- `tool_call`.
CREATE TABLE tool_call_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  message_id TEXT REFERENCES message (id),
  thread_id TEXT REFERENCES thread (id),
  turn_id TEXT REFERENCES turn (id),
  run_step_id TEXT,
  parent_call_id TEXT REFERENCES tool_call_new (id),
  -- The id the model gave the call; tool results go back to the model under it.
  model_call_id TEXT,
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('builtin', 'mcp', 'plugin', 'computer', 'browser', 'page', 'device')),
  server_id TEXT,
  plugin_id TEXT,
  origin TEXT NOT NULL DEFAULT 'model'
    CHECK (origin IN ('model', 'ui', 'hook', 'script', 'mcp_client')),
  args_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'awaiting_approval', 'running', 'ok', 'error', 'denied', 'timeout', 'cancelled')
  ),
  -- The policy decision (allow|deny|handoff) and the approval that resolved an `ask`, if any.
  decision TEXT,
  approval_id TEXT,
  tags_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
INSERT INTO tool_call_new (id, account_id, message_id, thread_id, turn_id, run_step_id,
    parent_call_id, model_call_id, tool_name, source, server_id, plugin_id, origin, args_json,
    result_json, error, status, decision, approval_id, tags_json, started_at, ended_at,
    duration_ms, created_at)
  SELECT id, account_id, message_id, thread_id, turn_id, run_step_id, parent_call_id,
    model_call_id, tool_name, source, server_id, plugin_id, origin, args_json, result_json, error,
    status, decision, approval_id, tags_json, started_at, ended_at, duration_ms, created_at
  FROM tool_call;
DROP TABLE tool_call;
ALTER TABLE tool_call_new RENAME TO tool_call;
CREATE INDEX idx_tool_call_thread ON tool_call (thread_id, created_at);
CREATE INDEX idx_tool_call_turn ON tool_call (turn_id);
CREATE INDEX idx_tool_call_message ON tool_call (message_id);
