-- Infrastructure and networking through chat (M10d). Not replicated: the tool runs, the plan files,
-- the state copies and the network snapshots are on this machine (workers/infra/, workers/network/).
--
-- An infrastructure project is a folder of the person's with a plan/apply tool's configuration, a
-- monthly budget (cents) and a price sheet; `secrets` lists the names of the environment variables
-- whose values are in the vault (infra/<id>/<NAME>). `alert_level` is the last budget level Nova
-- alerted about (ok, warn, over), so the heartbeat alerts once per level.
CREATE TABLE infra_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  tool TEXT NOT NULL,
  budget_cents INTEGER NOT NULL,
  prices TEXT NOT NULL,
  secrets TEXT NOT NULL,
  egress TEXT NOT NULL,
  alert_level TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A run: plan (tier 1), then apply (tier 3). `plan_sha` is the saved plan file's sha256, what the
-- person reviewed; `changes` the priced resource changes; `verdict` where the month would stand.
-- `checkpoint` is the home checkpoint taken before the apply, `state_before` the sha256 of the copy
-- of the tool's state file. `tasks` lists the run's tasks in order: [{step, id}].
CREATE TABLE infra_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES infra_project(id),
  title TEXT NOT NULL,
  destroy INTEGER NOT NULL,
  privacy_mode TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  plan_sha TEXT,
  plan_text TEXT,
  changes TEXT,
  delta_cents INTEGER,
  verdict TEXT,
  checkpoint TEXT,
  state_before TEXT,
  apply_out TEXT,
  tasks TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX infra_run_by_project ON infra_run (project_id, created_at);

-- What Nova provisioned, with its monthly price: every resource has a project, so a budget.
CREATE TABLE infra_resource (
  project_id TEXT NOT NULL REFERENCES infra_project(id),
  address TEXT NOT NULL,
  type TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, address)
);

-- A network target: something whose configuration Nova may change, through an adapter, with a token
-- in the vault (network/<id>/token).
CREATE TABLE network_target (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  adapter TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A change: prepare (snapshot and diff, tier 1), apply (tier 3), then the dead-man's switch, and a
-- revert when it fires. The snapshot and the new configuration are files in workers/network/<id>/;
-- here only their hashes and versions, the patch's shape (its keys; the patch itself is sealed beside
-- the snapshot), and the diff with every secret value masked. `applied_sha` and `stamped`: what the
-- target held right after Nova's write, and the paths the target set itself on it (a revision).
-- `revert_attempts`, `next_revert_at`: the switch trying a failed revert again; `problem_id`: the
-- problem that stays open until the snapshot is back or the person settles it. `devices` lists the devices
-- whose contact counts (trusted at the apply); `deadline` is when the switch fires without one.
CREATE TABLE network_change (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES network_target(id),
  title TEXT NOT NULL,
  patch TEXT NOT NULL,
  privacy_mode TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  snapshot_sha TEXT,
  snapshot_version TEXT,
  proposed_sha TEXT,
  applied_version TEXT,
  diff TEXT,
  changed_keys TEXT,
  window_s INTEGER NOT NULL,
  armed_at TEXT,
  deadline TEXT,
  devices TEXT,
  contact_at TEXT,
  contact_device TEXT,
  checkpoint TEXT,
  applied_sha TEXT,
  stamped TEXT,
  revert_attempts INTEGER NOT NULL DEFAULT 0,
  next_revert_at TEXT,
  problem_id INTEGER,
  tasks TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX network_change_by_state ON network_change (state, created_at);
