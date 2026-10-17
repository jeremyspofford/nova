-- 0002 — chat (M1): projects, provider accounts, threads, turns, messages, attachments, usage and
-- full-text search. Mirrors docs/06 §2 and §4; all timestamps UTC ISO-8601, ids UUIDv7.
-- Columns that point at tables arriving later (run, goal) are plain TEXT until those tables exist.

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'code', 'work')),
  instructions TEXT,
  memory_scope TEXT NOT NULL DEFAULT 'shared' CHECK (memory_scope IN ('shared', 'project_only')),
  upstream_project_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Credentials never live here: only a secret:// reference into the vault (FR-101, docs/06 §6.3).
CREATE TABLE provider_account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('oauth', 'api_key', 'none')),
  secret_ref TEXT CHECK (secret_ref IS NULL OR substr(secret_ref, 1, 9) = 'secret://'),
  base_url TEXT,
  scopes TEXT,
  entitlements TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_provider_account_account ON provider_account (account_id);

CREATE TABLE model_pref (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  alias TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  default_params TEXT,
  cost_in REAL,
  cost_out REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_model_pref_model ON model_pref (account_id, provider, model_id);

CREATE TABLE thread (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  project_id TEXT REFERENCES project (id),
  mode TEXT NOT NULL CHECK (mode IN ('chat', 'work', 'code', 'agent')),
  title TEXT,
  parent_thread_id TEXT REFERENCES thread (id),
  branch_from_message_id TEXT,
  temporary INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  reasoning_level TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle', 'streaming', 'waiting_approval', 'waiting_input', 'error')),
  input_mode TEXT NOT NULL DEFAULT 'steer' CHECK (input_mode IN ('steer', 'queue')),
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_thread_account_mode ON thread (account_id, mode, updated_at DESC);
CREATE INDEX idx_thread_project ON thread (project_id);

-- One trigger and everything the runtime did for it (docs/09 §2).
CREATE TABLE turn (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread (id),
  idx INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'interrupted', 'failed')),
  trigger TEXT NOT NULL DEFAULT 'user'
    CHECK (trigger IN ('user', 'schedule', 'goal', 'hook', 'event', 'channel')),
  trigger_ref TEXT,
  run_id TEXT,
  goal_id TEXT,
  execution_location TEXT NOT NULL,
  model_id TEXT,
  reasoning_level TEXT,
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count <= 200),
  stop_reason TEXT CHECK (
    stop_reason IS NULL OR stop_reason IN
      ('end', 'budget', 'backstop', 'cancelled', 'approval_timeout', 'location_lost', 'error')
  ),
  usage_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (thread_id, idx),
  CHECK (status = 'in_progress' OR ended_at IS NOT NULL)
);
CREATE INDEX idx_turn_open ON turn (thread_id) WHERE status = 'in_progress';

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread (id),
  turn_id TEXT REFERENCES turn (id),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool', 'summary')),
  author_kind TEXT,
  provenance TEXT NOT NULL DEFAULT 'typed'
    CHECK (provenance IN ('typed', 'pasted', 'tool', 'channel', 'capture', 'import')),
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('streaming', 'complete', 'incomplete', 'error')),
  model_id TEXT,
  provider TEXT,
  usage_json TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_message_thread ON message (thread_id, created_at);
CREATE INDEX idx_message_turn ON message (turn_id);
CREATE INDEX idx_message_streaming ON message (status) WHERE status = 'streaming';

CREATE TABLE message_part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message (id),
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  ref_id TEXT,
  mime TEXT,
  blob_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_message_part_message ON message_part (message_id, idx);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES message (id),
  thread_id TEXT REFERENCES thread (id),
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  origin TEXT NOT NULL DEFAULT 'upload'
    CHECK (origin IN ('upload', 'window_capture', 'dictation', 'import')),
  blob_path TEXT NOT NULL,
  extracted_text_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachment_message ON attachment (message_id);

-- Every streamed response writes one row (docs/07 §11).
CREATE TABLE usage_event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thread_id TEXT,
  turn_id TEXT,
  run_id TEXT,
  goal_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_event_account ON usage_event (account_id, created_at);

-- Chat search (docs/06 §4). `message_search` holds one row per non-empty text part, keyed by an
-- INTEGER PRIMARY KEY so the external-content FTS5 index keeps stable rowids across VACUUM (a
-- table with a TEXT primary key may be renumbered). Triggers keep both in step with
-- `message_part`; temporary and deleted threads are excluded at query time (FR-027).
CREATE TABLE message_search (
  seq INTEGER PRIMARY KEY,
  part_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX idx_message_search_message ON message_search (message_id);

CREATE VIRTUAL TABLE message_fts USING fts5 (
  text,
  content = 'message_search',
  content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_search_ai AFTER INSERT ON message_search BEGIN
  INSERT INTO message_fts (rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER message_search_ad AFTER DELETE ON message_search BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER message_search_au AFTER UPDATE ON message_search BEGIN
  INSERT INTO message_fts (message_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO message_fts (rowid, text) VALUES (new.seq, new.text);
END;

CREATE TRIGGER message_part_search_ai AFTER INSERT ON message_part
WHEN new.type = 'text' AND new.content IS NOT NULL AND new.content <> '' BEGIN
  INSERT INTO message_search (part_id, message_id, text)
  VALUES (new.id, new.message_id, new.content);
END;
CREATE TRIGGER message_part_search_au AFTER UPDATE OF content, type ON message_part BEGIN
  DELETE FROM message_search
  WHERE part_id = old.id
    AND NOT (new.type = 'text' AND new.content IS NOT NULL AND new.content <> '');
  INSERT INTO message_search (part_id, message_id, text)
  SELECT new.id, new.message_id, new.content
  WHERE new.type = 'text' AND new.content IS NOT NULL AND new.content <> ''
  ON CONFLICT (part_id) DO UPDATE SET text = excluded.text;
END;
CREATE TRIGGER message_part_search_ad AFTER DELETE ON message_part BEGIN
  DELETE FROM message_search WHERE part_id = old.id;
END;
