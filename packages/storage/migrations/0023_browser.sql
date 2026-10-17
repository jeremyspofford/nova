-- 0023 — M6 browser (FR-086, FR-094, FR-098; docs/11 §4, §9). All timestamps UTC ISO-8601, ids
-- UUIDv7. Computer, thread, turn and call ids are plain TEXT (no foreign keys): the computer table
-- belongs to 0022 and purges must never block on a trace row. Secrets never live here: a saved
-- login keeps only its `secret://browser/login/<id>` reference (docs/12 §5).

-- Sites on the allow list (with a permission level and the developer-protocol mode) or on the
-- block list (FR-094). `rule_id` is the site-scoped policy_rule the level is enforced with
-- (plain TEXT: the user can delete that rule in Settings without touching this row).
CREATE TABLE browser_site (
  account_id TEXT NOT NULL REFERENCES account (id),
  pattern TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('allow', 'block')),
  level TEXT CHECK (level IN ('always_ask', 'auto_review', 'always_allow')),
  dev_protocol INTEGER NOT NULL DEFAULT 0,
  rule_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, pattern),
  CHECK (access = 'allow' OR (level IS NULL AND dev_protocol = 0)),
  CHECK (access = 'block' OR level IS NOT NULL)
);

-- Every browser action with its before/after screenshots, for the Activity trace (FR-098).
-- Screenshot paths are relative to the data directory (blobs/screenshots/<yyyymmdd>/<id>.png)
-- and are cleared when retention removes the files.
CREATE TABLE browser_action (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  computer_id TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  call_id TEXT,
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  url TEXT,
  host TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'error', 'blocked', 'denied', 'handoff')),
  error TEXT,
  classification_json TEXT,
  before_path TEXT,
  after_path TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_browser_action_thread ON browser_action (account_id, thread_id, created_at);
CREATE INDEX idx_browser_action_call ON browser_action (call_id);
CREATE INDEX idx_browser_action_created ON browser_action (created_at);

-- Saved logins (FR-086): the password is a vault entry; reusing one needs the user's confirmation.
CREATE TABLE browser_login (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  host TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_ref TEXT NOT NULL CHECK (secret_ref LIKE 'secret://%'),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (account_id, host, username)
);
