-- 0027 — M6 screen: computer use, control tiers and grants, the kill key, recorded actions,
-- takeover and appshots (FR-093, FR-207, FR-098, FR-087, FR-075; docs/11 §4.2, §5, §6). All
-- timestamps UTC ISO-8601, ids UUIDv7. Computer, thread, turn and run ids are plain columns with
-- no foreign key: the computer table belongs to another area, and purges of threads or computers
-- never block on these rows (the computers area purges a deleted computer's rows here).

-- Computer use per computer: the explicit enablement toggle (FR-093) and the kill key's stop,
-- which holds until the user resumes control (docs/11 §5.2).
CREATE TABLE screen_control (
  computer_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Set by the kill key; cleared when the user resumes control.
  stopped_at TEXT,
  -- user | key | system
  stopped_by TEXT,
  updated_at TEXT NOT NULL
);

-- Per-app grants (FR-207, docs/12 §4.2): made only by the user, 30 minutes by default, renewable
-- and revocable. `tier` is the app's tier when it was granted.
CREATE TABLE screen_grant (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  computer_id TEXT NOT NULL,
  app TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('view', 'click', 'full')),
  granted_by TEXT NOT NULL,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renewed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_screen_grant_computer ON screen_grant (computer_id, expires_at)
  WHERE revoked_at IS NULL;

-- Every input action on a controlled desktop, refused ones included (FR-098): the agent's tool
-- calls with before/after screenshots (attachment blobs, encrypted at rest) and the user's input
-- during a takeover. Typed text is never stored: `args_json` keeps its length only.
CREATE TABLE screen_action (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  computer_id TEXT NOT NULL,
  -- user | system | agent:<id>
  actor TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('tool', 'takeover')),
  kind TEXT NOT NULL CHECK (kind IN ('click', 'scroll', 'type', 'key', 'drag')),
  args_json TEXT NOT NULL,
  app TEXT,
  window_title TEXT,
  tier TEXT CHECK (tier IN ('none', 'view', 'click', 'full')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'refused', 'failed', 'stopped')),
  error_code TEXT,
  error_message TEXT,
  thread_id TEXT,
  turn_id TEXT,
  call_id TEXT,
  takeover_id TEXT,
  before_blob TEXT,
  after_blob TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_screen_action_computer ON screen_action (computer_id, id);
CREATE INDEX idx_screen_action_created ON screen_action (created_at);

-- The user's takeovers of an agent's computer (FR-087): at most one open per computer.
CREATE TABLE screen_takeover (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  computer_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'browser')),
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- returned | restart
  end_reason TEXT,
  input_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_screen_takeover_open ON screen_takeover (computer_id)
  WHERE ended_at IS NULL;

-- Appshots (FR-075): an image artifact of a window, the screen or the browser page, with what it
-- shows.
CREATE TABLE screen_appshot (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  computer_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifact (id),
  source TEXT NOT NULL CHECK (source IN ('window', 'screen', 'browser')),
  app TEXT,
  window_title TEXT,
  url TEXT,
  width INTEGER,
  height INTEGER,
  thread_id TEXT,
  captured_by TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX idx_screen_appshot_computer ON screen_appshot (computer_id, captured_at);
