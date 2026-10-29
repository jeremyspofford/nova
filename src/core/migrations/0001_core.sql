-- M1 core: profile, Work Ledger, extensions, problems. Times are ISO-8601 UTC strings; JSON
-- columns hold the contract shapes from docs/builder-packet/CONTRACTS.md.

-- The profile (PROFILES-AND-CUSTOMIZATION): everything about one person lives here, never in code.
CREATE TABLE profile (
  section    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,              -- JSON
  source     TEXT NOT NULL,              -- setup | settings | conversation | import
  updated_at TEXT NOT NULL,
  PRIMARY KEY (section, key)
);

-- Work Ledger tasks (WORK-LEDGER-AND-VERIFICATION). brief and report are CONTRACTS §1 envelopes.
CREATE TABLE task (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  origin          TEXT NOT NULL,         -- JSON {kind: user|setup|trigger, ref}
  state           TEXT NOT NULL CHECK (state IN ('queued','active','waiting','verifying','done','failed','cancelled')),
  reason          TEXT,                  -- why it is in this state, in plain words
  owner           TEXT NOT NULL,         -- worker id
  brief           TEXT NOT NULL,         -- JSON Brief
  report          TEXT,                  -- JSON Report, once one arrives
  verification    TEXT,                  -- JSON: what was checked and how it came out
  privacy_mode    TEXT NOT NULL CHECK (privacy_mode IN ('local-only','local-preferred','cloud-allowed')),
  approval_tier   INTEGER NOT NULL CHECK (approval_tier BETWEEN 0 AND 3),
  approved_at     TEXT,
  cost            TEXT NOT NULL DEFAULT '{}',
  parent_id       TEXT REFERENCES task(id),
  user_visibility TEXT NOT NULL CHECK (user_visibility IN ('silent','handling','attention')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX task_state ON task(state);

-- Every state change, appended, never rewritten: the audit trail.
CREATE TABLE task_event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES task(id),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  detail     TEXT                        -- JSON
);
CREATE INDEX task_event_task ON task_event(task_id, seq);

-- Installed extensions (EXTENSION-MODEL); manifest is the CONTRACTS §4 document.
CREATE TABLE extension (
  id           TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  manifest     TEXT NOT NULL,            -- JSON
  state        TEXT NOT NULL CHECK (state IN ('installed','enabled','disabled')),
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Anything that went wrong and matters to the person. Problems are shown in the UI; the log
-- file is a copy, never the only place an error lives (NOVA-SPEC §8).
CREATE TABLE problem (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  source      TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      TEXT,
  task_id     TEXT REFERENCES task(id),
  resolved_at TEXT
);
