-- 0034 — M7 cloud runner (FR-108, FR-071, FR-116; docs/13 §3, docs/10 §12, contracts/rest-api.md
-- §5; ADR-095 decision 4). A cloud environment is an `environment` row of kind `cloud` (0018);
-- its `config_json` holds the runner's environment id and the spec (repository URLs without user
-- information, setup script, base image, caches, network, disk cap). The runner token is a vault
-- entry (`secret://cloud/runner/token`, named by the `cloud.runner.token` setting), never a row.
-- Thread and Work run ids are plain columns: threads can be purged, and runs belong to the runs
-- area. All timestamps UTC ISO-8601.

-- A Code session's or Work run's lease on a cloud environment (one runner run): its caps and the
-- usage the runner metered (FR-116). `lost` means the runner no longer knows the run.
-- `last_event_id` is where the Hub's event stream from the runner resumes.
CREATE TABLE cloud_run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  environment_id TEXT NOT NULL REFERENCES environment (id),
  thread_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('code', 'work', 'system')),
  work_run_id TEXT,
  runner_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled', 'capped', 'failed', 'lost')),
  reason TEXT,
  cpu_cap_s INTEGER NOT NULL,
  wall_cap_s INTEGER NOT NULL,
  cpu_used_s REAL NOT NULL DEFAULT 0,
  wall_used_s REAL NOT NULL DEFAULT 0,
  commands INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  last_event_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_cloud_run_thread ON cloud_run (account_id, thread_id, status);
CREATE INDEX idx_cloud_run_environment ON cloud_run (environment_id, status);
CREATE UNIQUE INDEX idx_cloud_run_runner ON cloud_run (runner_run_id);

-- A Work run whose commands and files go to a cloud environment (its thread's sandbox and
-- roots); the folder is the run's working folder there.
CREATE TABLE cloud_work_binding (
  thread_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  environment_id TEXT NOT NULL REFERENCES environment (id),
  work_run_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cloud_work_binding_environment ON cloud_work_binding (environment_id);

-- The Hub's index of a cloud environment's snapshots (the tar itself stays on the runner).
CREATE TABLE cloud_snapshot (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  environment_id TEXT NOT NULL REFERENCES environment (id),
  runner_snapshot_id TEXT NOT NULL,
  label TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'run_start', 'before_restore')),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX idx_cloud_snapshot_environment ON cloud_snapshot (environment_id, created_at DESC);
