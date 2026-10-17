-- 0016 — M5 Work runs, plans, goals and sub-agents (FR-051..FR-054, FR-181, FR-182, FR-186,
-- FR-187, FR-220; docs/06 "work runs, goals"). A run is a `work` thread plus a `run` row; its turns
-- run in the one chat loop (ADR-076). All timestamps UTC ISO-8601, ids UUIDv7. There is no
-- `agent` table until M6, so `agent_id` columns are plain TEXT without a foreign key.

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  project_id TEXT REFERENCES project (id),
  thread_id TEXT NOT NULL REFERENCES thread (id),
  agent_id TEXT,
  -- Delegation (FR-059); a child run's consumption counts toward its parent.
  parent_run_id TEXT REFERENCES run (id),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'schedule', 'trigger',
    'chat_escalation', 'delegation', 'goal')),
  -- The chat a run escalated from (FR-186), the schedule or trigger that fired it.
  origin_ref TEXT,
  template TEXT CHECK (template IS NULL OR template IN ('deep_research')),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  -- Whose words the objective carries (FR-189): `user` when the signed-in user typed it, or
  -- accepted a proposed run with Start; `none` when a model or an agent wrote it.
  authority TEXT NOT NULL DEFAULT 'none' CHECK (authority IN ('user', 'none')),
  authority_source TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('planning', 'running', 'waiting_approval', 'paused',
    'done', 'output_missing', 'failed', 'cancelled')),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('user', 'budget_time',
    'budget_tokens', 'budget_cost', 'backstop', 'usage_limit', 'approval_timeout',
    'review_breaker', 'safety', 'error')),
  -- Why it paused or failed, in a sentence (an error message, the bound that was reached).
  status_detail TEXT,
  autonomy TEXT NOT NULL DEFAULT 'standard' CHECK (autonomy IN ('ask_first', 'standard',
    'autonomous')),
  -- The user approved the plan (Start on an ask_first run) or wrote it (PUT /runs/:id/plan).
  plan_approved INTEGER NOT NULL DEFAULT 0,
  -- Budgets (FR-182, ADR-058); cost_budget_usd NULL = no cap until the provider spend cap.
  time_budget_s INTEGER NOT NULL DEFAULT 3600,
  token_budget INTEGER NOT NULL DEFAULT 2000000,
  cost_budget_usd REAL,
  -- Consumption, child runs and sub-agents included; time only while a turn runs (in ms, so
  -- many short steps add up exactly).
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0,
  -- The progress summary of the last pause or turn (the last reply, or a generated one).
  progress_note TEXT,
  -- User redirects waiting for the running turn to end (JSON array of strings).
  pending_json TEXT,
  -- Consecutive turns that ended in an error; the run fails at the limit (docs/09 §12).
  error_count INTEGER NOT NULL DEFAULT 0,
  expected_output_json TEXT,
  output_verified_at TEXT,
  result_summary TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (status <> 'paused' OR pause_reason IS NOT NULL),
  CHECK (status <> 'done' OR expected_output_json IS NULL OR output_verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_run_thread ON run (thread_id);
CREATE INDEX idx_run_status ON run (account_id, status, updated_at DESC);
CREATE INDEX idx_run_parent ON run (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- One goal per run or agent at a time (FR-181, docs/09 §2.1, contracts/schemas/goal.json).
CREATE TABLE goal (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  run_id TEXT REFERENCES run (id),
  agent_id TEXT,
  -- Where continuation turns (trigger `goal`) run.
  thread_id TEXT REFERENCES thread (id),
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 4000),
  -- Who wrote the objective: the user (trusted context) or the agent through goal.set.
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'blocked',
    'usage_limited', 'budget_limited', 'complete')),
  status_set_by TEXT NOT NULL DEFAULT 'user' CHECK (status_set_by IN ('user', 'agent', 'system')),
  status_reason TEXT,
  progress_note TEXT,
  completion_summary TEXT,
  -- NULL = the run's budgets apply.
  token_budget INTEGER,
  time_budget_s INTEGER,
  cost_budget_usd REAL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0,
  -- The blocked rule: the normalized key of the last reported blocker, its description, the
  -- number of consecutive goal turns that reported it and the last of those turns.
  blocker_key TEXT,
  blocker_description TEXT,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  blocker_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((run_id IS NULL) <> (agent_id IS NULL)),
  CHECK (status NOT IN ('usage_limited', 'budget_limited') OR status_set_by = 'system'),
  CHECK (status <> 'blocked' OR status_set_by <> 'agent' OR blocker_count >= 3)
);
CREATE UNIQUE INDEX uq_goal_open_run ON goal (run_id)
  WHERE run_id IS NOT NULL AND status <> 'complete';
CREATE UNIQUE INDEX uq_goal_open_agent ON goal (agent_id)
  WHERE agent_id IS NOT NULL AND status <> 'complete';
CREATE INDEX idx_goal_account ON goal (account_id, status, updated_at DESC);

-- The plan: ordered steps the model proposes (plan.set) or the user edits (FR-051, docs/09 §3).
CREATE TABLE run_step (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run (id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  detail_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (run_id, idx)
);

-- Sub-agents (FR-053, FR-054, docs/09 §4): a child `work` thread whose parent is the run's thread.
-- A queued child has no thread until it starts.
CREATE TABLE subagent (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run (id),
  thread_id TEXT REFERENCES thread (id),
  role TEXT NOT NULL,
  objective TEXT NOT NULL,
  -- The tool allow-list the parent gave it (JSON array), never wider than the parent's tools.
  tools_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  -- task.message input waiting for the child's running turn to end (JSON array of strings).
  inbox_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_subagent_run ON subagent (run_id, created_at);
CREATE UNIQUE INDEX uq_subagent_thread ON subagent (thread_id) WHERE thread_id IS NOT NULL;
