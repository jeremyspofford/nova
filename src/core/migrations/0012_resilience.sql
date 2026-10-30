-- Resilience (M7 plan §2–§3): repair playbooks, nightly backups and restore drills. None of these
-- replicate: each node keeps its own record of what it repaired, backed up and restored.

-- Which playbook a problem follows (resilience/playbooks.ts), what it is about (a worker, a
-- connector, a device) so one stays open per thing, and every repair Nova tried, in order.
CREATE TABLE problem_playbook (
  problem_id INTEGER PRIMARY KEY,
  playbook TEXT NOT NULL,
  subject TEXT,
  repairs TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX problem_playbook_subject ON problem_playbook (playbook, subject);

-- Every backup Nova made or tried to make: where it went, how big, and what went wrong if it
-- didn't finish. The backup itself (and its manifest) lives in the folder the person named.
CREATE TABLE backup_run (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  target TEXT NOT NULL,
  path TEXT,
  ok INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  encrypted_path TEXT,
  error TEXT,
  task_id TEXT
);
CREATE INDEX backup_run_seq ON backup_run (seq);

-- Every restore drill: which backup, each check with its result in plain words, and the ledger
-- task it ran as. A failed drill is a problem with its playbook.
CREATE TABLE backup_drill (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  backup_id TEXT,
  ok INTEGER NOT NULL,
  checks TEXT NOT NULL,
  task_id TEXT
);
