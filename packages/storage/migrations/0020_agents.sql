-- 0020 — M6 always-on agents (FR-079, FR-080, FR-082..FR-084, FR-089, FR-090, FR-181, FR-194,
-- FR-206; docs/06 "agents & computers", docs/09 §8, docs/12 §3, §6.2). All timestamps UTC
-- ISO-8601, ids UUIDv7. Tables of later areas (computer 0022, channel_binding 0021) are named by
-- plain TEXT ids. Runs, schedules and goals already carry a plain `agent_id`.

-- An always-on agent. `instructions` is the user's own text (docs/06 `persona`); budgets cap each
-- turn chain (a turn plus its hook continuations); the usage columns are lifetime totals.
CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- A sealed, metadata-stripped blob (as the account avatar, FR-113).
  avatar_path TEXT,
  instructions TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 16000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  -- Who paused it: the user, or safety monitoring (auto-pause, FR-090).
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('user', 'safety')),
  status_detail TEXT,
  autonomy TEXT NOT NULL DEFAULT 'standard'
    CHECK (autonomy IN ('ask_first', 'standard', 'autonomous')),
  model TEXT,
  -- Its persistent cloud computer (FR-080); the computer table arrives in 0022.
  computer_id TEXT,
  -- The in-app `agent` thread; private channel bindings may share it.
  primary_thread_id TEXT REFERENCES thread (id) ON DELETE SET NULL,
  proactive INTEGER NOT NULL DEFAULT 1,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  time_budget_s INTEGER NOT NULL CHECK (time_budget_s >= 60),
  token_budget INTEGER NOT NULL CHECK (token_budget >= 1000),
  cost_budget_usd REAL CHECK (cost_budget_usd IS NULL OR cost_budget_usd >= 0),
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0,
  last_proactive_at TEXT,
  last_active_at TEXT,
  -- JSON: the schedules and runs a pause stopped, restored on resume.
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'paused' OR pause_reason IS NOT NULL)
);
CREATE INDEX idx_agent_account ON agent (account_id, created_at);

-- Every thread of an agent: the main thread, its proactive research thread, one thread per
-- channel binding (ADR-070) and the Work run threads it delegated (background work, FR-083).
CREATE TABLE agent_thread (
  thread_id TEXT PRIMARY KEY REFERENCES thread (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('main', 'proactive', 'binding', 'background')),
  -- The channel binding (0021) for `binding` threads.
  binding_ref TEXT,
  -- private (owner only) | shared: where the thread's content may go (docs/13 §4).
  audience TEXT NOT NULL DEFAULT 'private' CHECK (audience IN ('private', 'shared')),
  -- The delegated run of a `background` thread (plain: run history outlives the agent).
  run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind <> 'binding' OR binding_ref IS NOT NULL),
  CHECK (kind <> 'background' OR run_id IS NOT NULL)
);
CREATE INDEX idx_agent_thread_agent ON agent_thread (agent_id, kind);
CREATE UNIQUE INDEX uq_agent_thread_binding ON agent_thread (agent_id, binding_ref)
  WHERE binding_ref IS NOT NULL;

-- Responsibilities, tracked separately; one of them may hold the agent's open goal.
CREATE TABLE agent_responsibility (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 4000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  goal_id TEXT REFERENCES goal (id) ON DELETE SET NULL,
  -- The agent's last progress note (agent-written: untrusted).
  progress_note TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_responsibility_agent ON agent_responsibility (agent_id, position);

-- Custom rules (FR-084, docs/12 §3): act | act_on_request | ask | handoff over tools, hosts,
-- action classes and channels, optionally a command prefix rule (FR-191). The engine sees them
-- as policy rules scoped to the agent.
CREATE TABLE agent_rule (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  matcher_json TEXT NOT NULL,
  command_json TEXT,
  effect TEXT NOT NULL CHECK (effect IN ('act', 'act_on_request', 'ask', 'handoff')),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A command prefix rule decides allow or ask only (docs/12 §3.1).
  CHECK (command_json IS NULL OR effect IN ('act', 'ask'))
);
CREATE INDEX idx_agent_rule_agent ON agent_rule (agent_id, enabled);

-- Notes and learned items (FR-089, ADR-080): durable, user-visible, editable, forgettable. Notes
-- the agent wrote are untrusted; `origin_audience` is the audience of the thread they came from.
CREATE TABLE agent_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'fact', 'preference', 'observation')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'tool', 'proactive', 'conversation')),
  source_thread_id TEXT,
  responsibility_id TEXT REFERENCES agent_responsibility (id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  origin_audience TEXT NOT NULL DEFAULT 'private' CHECK (origin_audience IN ('private', 'shared')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_memory_agent ON agent_memory (agent_id, kind, updated_at);

-- Suggestions from proactive research (FR-082): shown as a card in the agent thread and a
-- notification; they never count as the user's intent (FR-189).
CREATE TABLE agent_suggestion (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  note_id TEXT REFERENCES agent_memory (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  thread_id TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_agent_suggestion_agent ON agent_suggestion (agent_id, status, created_at);

-- Self-set wakes (FR-206): one row per accepted schedule.wake, kept when the user cancels the
-- schedule, so the per-day limit counts every wake the agent set.
CREATE TABLE agent_wake (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  schedule_id TEXT,
  at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  moved_by_quiet_hours INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_wake_agent ON agent_wake (agent_id, created_at);

-- Identities the user marked as external AI agents (FR-194, docs/12 §6.2): a channel identity,
-- an email address or a name such as "the billing agent".
CREATE TABLE external_agent (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 300),
  label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, address)
);
