-- 0018 — M5 Code sessions (FR-061..FR-066, FR-069, FR-073, FR-074, FR-211). Mirrors docs/06
-- "code sessions" with the columns the Hub needs: a session's account and folder, a change's
-- review state and pending patch, comment authorship and batches, and stored reviews. The
-- symbol index lives in memory; worktrees are registered here (at most 15 active per repo).

-- Where sessions run. M5 has one built-in `local` environment per account (the Hub host);
-- other kinds come with FR-062. `device_id` is set for device and SSH helper environments.
CREATE TABLE environment (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL
    CHECK (kind IN ('local', 'cloud', 'ssh', 'wsl', 'container', 'vm', 'device')),
  device_id TEXT REFERENCES device (id),
  label TEXT NOT NULL,
  config_json TEXT,
  repo_urls TEXT,
  setup_script TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok', 'degraded', 'down', 'unknown')),
  status_detail TEXT,
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_environment_local ON environment (account_id) WHERE kind = 'local';

-- A Code session: a `code` thread bound to an environment, a folder and a permission mode
-- (FR-061, FR-063). `folder_path` is the canonical folder the user chose (the main checkout
-- when the session works in a worktree). The model and title live on the thread. The
-- permission profile follows from the mode; `permission_profile_id` is reserved for a custom
-- profile (built-in profiles are data in packages/policy, so it has no foreign key).
CREATE TABLE code_session (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  thread_id TEXT NOT NULL UNIQUE REFERENCES thread (id),
  environment_id TEXT REFERENCES environment (id),
  folder_path TEXT NOT NULL,
  project_folder_id TEXT REFERENCES project_folder (id),
  worktree_id TEXT REFERENCES worktree (id),
  branch TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (permission_mode IN ('manual', 'accept_edits', 'plan', 'auto', 'bypass')),
  permission_profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  pull_request_url TEXT,
  ci_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_code_session_account ON code_session (account_id, updated_at DESC);

-- The worktree registry (FR-073): `<repo>/.nova/worktrees/<name>` on `nova/<slug>`, leased to one
-- session at a time; released when the session is archived. `device_id` NULL is the Hub.
CREATE TABLE worktree (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT REFERENCES device (id),
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  lease_session_id TEXT REFERENCES code_session (id),
  lease_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, path)
);
CREATE INDEX idx_worktree_repo ON worktree (device_id, repo_path, status);
CREATE UNIQUE INDEX idx_worktree_hub_path ON worktree (path) WHERE device_id IS NULL;

-- One file the session changed (FR-064, FR-065), relative to the session folder. The pending
-- part (work tree against the session's baseline) is a unified patch blob under the data
-- folder; hunks already decided are kept in `decided_json` ({hunks, file}) for the current
-- review round. `state` is derived from both: a file with decided and pending hunks, or with
-- accepted and rejected ones, is `partial`. `applied` is 1 once the change was committed.
CREATE TABLE code_change (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES code_session (id),
  path TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('add', 'modify', 'delete', 'rename')),
  old_path TEXT,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  patch_blob_path TEXT,
  patch_sha256 TEXT,
  decided_json TEXT NOT NULL DEFAULT '{"hunks":[],"file":null}',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'accepted', 'rejected', 'partial')),
  call_id TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_code_change_path ON code_change (session_id, path);

-- A structured review of the session's diff (FR-069); findings are also diff comments.
CREATE TABLE code_review (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES code_session (id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  model_id TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_code_review_session ON code_review (session_id, created_at DESC);

-- A comment on a diff line (FR-065), by the user or from a review finding. A batch the user
-- submits is sent to the agent as one turn (`submitted_at`).
CREATE TABLE diff_comment (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES code_change (id),
  session_id TEXT NOT NULL REFERENCES code_session (id),
  path TEXT,
  line INTEGER,
  side TEXT CHECK (side IS NULL OR side IN ('old', 'new')),
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user' CHECK (author IN ('user', 'review')),
  review_id TEXT REFERENCES code_review (id),
  submitted_at TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_diff_comment_session ON diff_comment (session_id, created_at);
