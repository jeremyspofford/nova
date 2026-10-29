-- M2 long-term memory (CONTRACTS §7) and context receipts (CONTRACTS §2).

-- One remembered thing, with where it came from. A correction is a new record that supersedes
-- the old one; the old one stays, so history is never rewritten. Forgetting deletes the whole
-- chain for real. The links are checked at commit so a chain can be removed in one transaction.
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('timeline','entity','fact','preference','decision','commitment')),
  content       TEXT NOT NULL,
  source        TEXT,                    -- where it came from: a session, a file, a correction
  observed_at   TEXT NOT NULL,
  recorded_by   TEXT NOT NULL,           -- nova | person | import | <worker id>
  confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  scope         TEXT NOT NULL DEFAULT 'personal',
  supersedes    TEXT REFERENCES memory(id) DEFERRABLE INITIALLY DEFERRED,
  superseded_by TEXT REFERENCES memory(id) DEFERRABLE INITIALLY DEFERRED,
  expires       TEXT,
  user_state    TEXT NOT NULL CHECK (user_state IN ('confirmed','unreviewed','corrected')),
  created_at    TEXT NOT NULL
);
CREATE INDEX memory_kind ON memory(kind, scope);

-- What happened to memory, without what it said: forgetting must leave no content behind.
CREATE TABLE memory_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,               -- remembered | corrected | confirmed | forgotten
  memory_id TEXT NOT NULL,               -- no reference: the record may be gone
  by        TEXT NOT NULL
);

-- What a model was told, and where it went. egress is 'local' or 'remote:<name>'; the egress
-- log is every remote receipt.
CREATE TABLE receipt (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  task_id       TEXT,
  session_id    TEXT,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  privacy_mode  TEXT NOT NULL CHECK (privacy_mode IN ('local-only','local-preferred','cloud-allowed')),
  egress        TEXT NOT NULL,
  context_items TEXT NOT NULL            -- JSON [{kind, ref, sha256}]
);
CREATE INDEX receipt_task ON receipt(task_id);
CREATE INDEX receipt_session ON receipt(session_id);
