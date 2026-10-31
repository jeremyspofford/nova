-- Nova Computer (M10a). None of these replicate: a workspace is a container on this machine, and its
-- checkpoints and run records are files here (workers/computer/).

-- A workspace: one project's machine. `folder` is what is mounted; `own_folder` when Nova made it
-- (under workers/computer/<id>/project) rather than a folder of the person's. `egress` is the
-- declaration ({mode, hosts}). `image` is what the machine is made from now (the pinned image, or a
-- checkpoint's after a reset).
CREATE TABLE computer_workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  own_folder INTEGER NOT NULL,
  egress TEXT NOT NULL,
  container TEXT,
  image TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A checkpoint: the machine's image and a copy of the folder (workers/computer/<ws>/checkpoints/<id>),
-- with the copy's digest. `kind`: clean (taken at creation), auto (before a write or a reset), named.
CREATE TABLE computer_checkpoint (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  reason TEXT NOT NULL,
  image TEXT NOT NULL,
  digest TEXT NOT NULL,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX computer_checkpoint_ws ON computer_checkpoint (workspace_id, created_at);

-- Every computer task's own record, which its evidence is checked against: the op, and for a command
-- its output file's hash (workers/computer/runs/<task>.json) and the ingest screen it passed.
CREATE TABLE computer_run (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  op TEXT NOT NULL,
  argv TEXT,
  access TEXT,
  exit_code INTEGER,
  sha256 TEXT,
  bytes INTEGER,
  screen_id TEXT,
  verdict TEXT,
  checkpoint_id TEXT,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX computer_run_ws ON computer_run (workspace_id, at);
