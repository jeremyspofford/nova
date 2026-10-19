-- 0036 — M7 Code additions (docs/10 §9, §14, §15; FR-212, FR-213, FR-073): session handoffs with
-- their Git state (docs/06 `session_handoff`), best-of-N attempt sets and their attempts, three-way
-- merges with their conflicts, and delegations from an agent to a Code session. SSH host keys
-- pinned on first use stay in `environment.config_json` (`hostKey`) with the rest of the
-- connection. Agent ids are plain TEXT: an agent's removal never waits on its delegations.

-- A move of a Code session (or a chat: `code_session_id` NULL) to another device, environment or
-- worktree (FR-213), recorded in the session history. `from_ref`/`to_ref` are
-- `environment:<id>`, `worktree:<id>`, `device:<id>` or `hub`. `git_state_json` holds the branch,
-- HEAD, the working-state tree and the hashes of the patch and bundle (HandoffGitStateView); the
-- patch and bundle themselves are files under the data folder (`code/handoffs/<id>/`).
CREATE TABLE session_handoff (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  thread_id TEXT NOT NULL REFERENCES thread (id),
  code_session_id TEXT REFERENCES code_session (id),
  from_ref TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  from_label TEXT NOT NULL,
  to_label TEXT NOT NULL,
  target_folder TEXT,
  source_action TEXT NOT NULL DEFAULT 'keep' CHECK (source_action IN ('keep', 'clean')),
  git_state_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'refused', 'failed')),
  reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_session_handoff_thread ON session_handoff (thread_id, created_at DESC);
CREATE INDEX idx_session_handoff_session ON session_handoff (code_session_id, created_at DESC);

-- A best-of-N task (FR-212): N attempts of one objective from the session's HEAD (`base_sha`),
-- each its own Code session in its own worktree. `applied_attempt_id` and `merge_id` are set when
-- the user applied one.
CREATE TABLE code_attempt_set (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  session_id TEXT NOT NULL REFERENCES code_session (id),
  objective TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ready', 'applied', 'discarded')),
  applied_attempt_id TEXT,
  merge_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_code_attempt_set_session ON code_attempt_set (session_id, created_at DESC);

-- One attempt: its own session (thread, worktree, budgets in code_session_state), its model and
-- its last reply (the model's words: untrusted).
CREATE TABLE code_attempt (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES code_attempt_set (id),
  idx INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES code_session (id),
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'failed', 'applied', 'discarded')),
  reply TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (set_id, idx)
);
CREATE INDEX idx_code_attempt_session ON code_attempt (session_id);

-- A three-way merge onto a session's folder (docs/10 §9, §14): another session's work, an
-- attempt or a patch. `files_json` is MergeFileView[], `conflicts_json` MergeConflictView[]
-- (bounded, redacted). `backup_path` (under the data folder) keeps the files as they were, so a
-- conflicted merge can be aborted. A conflict is never resolved silently.
CREATE TABLE code_merge (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES code_session (id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('session', 'attempt', 'patch')),
  source_ref TEXT,
  base_sha TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('applied', 'conflicted', 'resolved', 'refused', 'aborted')),
  files_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  backup_path TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_code_merge_session ON code_merge (session_id, created_at DESC);

-- A Code session an agent started with `code.delegate` (docs/09 §4): the agent's rules apply in
-- its thread, and its result returns to the agent.
CREATE TABLE code_delegation (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  agent_id TEXT NOT NULL,
  agent_thread_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES code_session (id),
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX idx_code_delegation_thread ON code_delegation (thread_id);
CREATE INDEX idx_code_delegation_agent ON code_delegation (agent_id, created_at DESC);
