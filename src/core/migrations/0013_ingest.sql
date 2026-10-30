-- The ingest security gate (Amendment 2026-10-30-C Part 3). None of these replicate: each node
-- keeps its own record of what it screened and what waits for the person.

-- Every screen: which source, what the checks and the model found, the verdict, and a hash of the
-- content. The content itself is never kept here. A block also has its Work Ledger task.
CREATE TABLE ingest_screen (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  ref TEXT,
  sha256 TEXT NOT NULL,
  length INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  partial INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  scores TEXT,
  max REAL,
  flags TEXT NOT NULL,
  model TEXT,
  task_id TEXT
);
CREATE INDEX ingest_screen_at ON ingest_screen (at);

-- Things held back until the person turns them on (a skill from outside that was quarantined).
CREATE TABLE ingest_hold (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  reasons TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- Memory a run that read outside content wanted to write: waiting for the person, with where it
-- came from. Not in any prompt until the person keeps it; dropping one deletes it.
CREATE TABLE memory_candidate (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  op TEXT NOT NULL,
  kind TEXT,
  content TEXT,
  target TEXT,
  replaces TEXT,
  source TEXT,
  taint TEXT NOT NULL
);

-- Files Nova wrote itself, in a run that read nothing from outside, by content hash. Any other
-- file in the workspace (written by a command, a provider, a download, or changed since) is of
-- unknown provenance, and is screened before a model reads it.
CREATE TABLE file_provenance (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  at TEXT NOT NULL
);
