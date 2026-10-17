-- 0025 — M6 Code additions (docs/10 §2, §7-§10; FR-062, FR-068, FR-070, FR-073, FR-078). Saved
-- environments reuse `environment` (0018: `config_json` holds the connection, never a secret;
-- SSH credentials live in the keychain) and the worktree registry reuses `worktree` (0018:
-- `lease_expires_at`). This adds connected Git hosts, session pull requests with their CI state,
-- auto-verify runs and per-session state (budgets, environment setup, task.spawn workers).

-- A Git host connected for pushes and pull requests (FR-070). The token is in the keychain at
-- `token_ref` (`secret://code/githost/<id>/token`); only the login it signs in as is kept here.
CREATE TABLE git_host (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('github')),
  label TEXT NOT NULL,
  api_url TEXT NOT NULL,
  web_url TEXT NOT NULL,
  login TEXT,
  token_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok', 'error', 'unknown')),
  status_detail TEXT,
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_git_host_web ON git_host (account_id, web_url);

-- A pull request a Code session opened, with its last CI state (FR-070). `repo` is
-- `owner/name` on the host; `checks_json` holds the checks as the host reported them (their
-- summaries are untrusted text). `feedback_sha` is the head whose CI failure was already sent
-- to the agent, so a failure is fed back once per pushed head.
CREATE TABLE code_pull_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  session_id TEXT NOT NULL REFERENCES code_session (id),
  host_id TEXT NOT NULL REFERENCES git_host (id),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'merged')),
  ci_status TEXT NOT NULL DEFAULT 'none'
    CHECK (ci_status IN ('none', 'queued', 'running', 'passed', 'failed')),
  checks_json TEXT NOT NULL DEFAULT '[]',
  feedback_sha TEXT,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_code_pull_request_session ON code_pull_request (session_id, created_at DESC);
CREATE INDEX idx_code_pull_request_open ON code_pull_request (state);

-- One auto-verify run (FR-068): the project's checks after a turn edited files, or on request.
-- `checks_json` holds each command with its status, exit code and a redacted, capped log.
CREATE TABLE code_verify_run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES code_session (id),
  trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'passed', 'failed', 'error', 'skipped')),
  checks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_code_verify_run_session ON code_verify_run (session_id, created_at DESC);

-- Per-session M6 state. Budgets (docs/09 §2) as limits plus usage: active time in milliseconds,
-- tokens and cost; `budget_reached` names the bound that stopped the last turn. The setup
-- script of a container environment runs once per session (`setup_*`). A worker started with
-- `task.spawn` records its parent session and role (FR-073).
CREATE TABLE code_session_state (
  session_id TEXT PRIMARY KEY REFERENCES code_session (id),
  time_limit_s INTEGER,
  token_limit INTEGER,
  cost_limit_usd REAL,
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0,
  budget_reached TEXT CHECK (budget_reached IS NULL OR budget_reached IN ('time', 'tokens', 'cost')),
  setup_status TEXT CHECK (setup_status IS NULL OR setup_status IN ('running', 'ok', 'failed')),
  setup_detail TEXT,
  parent_session_id TEXT REFERENCES code_session (id),
  role TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_code_session_state_parent ON code_session_state (parent_session_id);
