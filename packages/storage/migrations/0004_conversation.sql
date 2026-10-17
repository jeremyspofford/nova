-- 0004 — M2 conversation: message tree (FR-020), queued follow-ups (FR-019), project sources and
-- their chunks (FR-040), citations, and memory items (FR-032). Mirrors docs/06 §2; all timestamps
-- UTC ISO-8601, ids UUIDv7.

-- Message tree (FR-020). Every message points at the one it follows; edits and regenerations add
-- siblings, so prior turns are never mutated. A thread's active path is the chain from
-- `active_leaf_id` up to the root. Branch threads start from a message of their parent thread
-- and inherit its path by reference. Plain TEXT columns (no FK) so purges can delete in any order.
ALTER TABLE message ADD COLUMN parent_id TEXT;
-- How a user message entered its turn while another was running: a steer of the running turn or
-- a queued send (FR-019). NULL means it was sent normally. Separate from `provenance` (FR-189),
-- which records where the text came from.
ALTER TABLE message ADD COLUMN delivery TEXT CHECK (delivery IS NULL OR delivery IN ('steer', 'queued'));
ALTER TABLE thread ADD COLUMN active_leaf_id TEXT;
CREATE INDEX idx_message_parent ON message (parent_id);

-- Backfill M1 rows: each message follows the previous one in its thread; the active leaf is the
-- newest live message.
UPDATE message SET parent_id = (
  SELECT p.id FROM message p
  WHERE p.thread_id = message.thread_id
    AND (p.created_at < message.created_at OR (p.created_at = message.created_at AND p.id < message.id))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT 1
);
UPDATE thread SET active_leaf_id = (
  SELECT m.id FROM message m
  WHERE m.thread_id = thread.id AND m.deleted_at IS NULL
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
);

-- Input sent while a turn runs, in `queue` mode (FR-019, docs/09 §2). Survives a restart; the
-- oldest pending row starts as its own turn when the running one ends. `id` becomes the id of the
-- user message it creates. Attachments are already stored blobs (JSON list of name, mime, size,
-- sha256, blob_path).
CREATE TABLE queued_input (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  text TEXT NOT NULL,
  attachments TEXT,
  model TEXT,
  reasoning_level TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'cancelled')),
  turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_queued_input_pending ON queued_input (thread_id, created_at) WHERE status = 'pending';

-- Project sources (FR-040): uploaded or pasted files, indexed in the background into chunks.
-- Content is a blob under the data directory (docs/06 §3), never in this table.
CREATE TABLE source (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  project_id TEXT NOT NULL REFERENCES project (id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexing', 'ready', 'error')),
  error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_source_project ON source (project_id, status);

-- Chunks of a source's text for retrieval. INTEGER PRIMARY KEY so the external-content FTS5 index
-- keeps stable rowids (as message_search in 0002).
CREATE TABLE source_chunk (
  seq INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source (id),
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_source_chunk_source ON source_chunk (source_id, idx);

CREATE VIRTUAL TABLE source_chunk_fts USING fts5 (
  text,
  content = 'source_chunk',
  content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER source_chunk_ai AFTER INSERT ON source_chunk BEGIN
  INSERT INTO source_chunk_fts (rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER source_chunk_ad AFTER DELETE ON source_chunk BEGIN
  INSERT INTO source_chunk_fts (source_chunk_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER source_chunk_au AFTER UPDATE ON source_chunk BEGIN
  INSERT INTO source_chunk_fts (source_chunk_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO source_chunk_fts (rowid, text) VALUES (new.seq, new.text);
END;

-- Sources used in an answer (docs/06 citation); `source_id` is set for project sources.
CREATE TABLE citation (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message (id),
  idx INTEGER,
  url TEXT,
  source_id TEXT,
  title TEXT,
  snippet TEXT,
  retrieved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_citation_message ON citation (message_id, idx);

-- Canonical, reviewable memory (FR-032, ADR-069; docs/06 memory_item). `content_key` is the
-- normalized content used to skip duplicates within a scope.
CREATE TABLE memory_item (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'thread', 'agent')),
  scope_ref TEXT,
  content TEXT NOT NULL,
  content_key TEXT NOT NULL,
  kind TEXT,
  category TEXT,
  confidence REAL,
  as_of TEXT,
  valid_until TEXT,
  source_kind TEXT NOT NULL DEFAULT 'chat'
    CHECK (source_kind IN ('chat', 'consolidation', 'import', 'ambient', 'manual')),
  source_thread_id TEXT,
  source_message_id TEXT,
  origin_audience TEXT NOT NULL DEFAULT 'private' CHECK (origin_audience IN ('private', 'shared')),
  -- memory_consolidation_run arrives with FR-204 (M3); plain column until then.
  consolidation_run_id TEXT,
  supersedes_id TEXT REFERENCES memory_item (id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed')),
  user_edited INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_scope ON memory_item (account_id, scope_kind, scope_ref, status);
CREATE INDEX idx_memory_key ON memory_item (account_id, scope_kind, scope_ref, content_key);

-- Full-text index over memory content, kept in step by triggers (relevance in context, list q=).
CREATE VIRTUAL TABLE memory_fts USING fts5 (
  content,
  item_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER memory_item_ai AFTER INSERT ON memory_item BEGIN
  INSERT INTO memory_fts (content, item_id) VALUES (new.content, new.id);
END;
CREATE TRIGGER memory_item_au AFTER UPDATE OF content ON memory_item BEGIN
  DELETE FROM memory_fts WHERE item_id = old.id;
  INSERT INTO memory_fts (content, item_id) VALUES (new.content, new.id);
END;
CREATE TRIGGER memory_item_ad AFTER DELETE ON memory_item BEGIN
  DELETE FROM memory_fts WHERE item_id = old.id;
END;
