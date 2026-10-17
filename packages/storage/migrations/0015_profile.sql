-- 0015 — M4 profile, active provider accounts, usage insights and the import ledger (FR-113,
-- FR-114, FR-115, FR-200; docs/06 `account`, `usage_event`, `import_record`). All timestamps UTC
-- ISO-8601, ids UUIDv7. The profile uses the 0001 `account` columns; the avatar is a sealed blob
-- under `<dataDir>/blobs/` named by `avatar_path`.

-- Usernames are unique among live accounts (FR-113).
CREATE UNIQUE INDEX uq_account_username ON account (username)
  WHERE username IS NOT NULL AND deleted_at IS NULL;

-- One active provider account per provider kind (FR-115). Without a row, or when the row points
-- at a removed account, the oldest live account of the kind is the active one.
CREATE TABLE provider_active (
  account_id TEXT NOT NULL REFERENCES account (id),
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- Usage insights read a time range of turns for the longest one (FR-114); usage_event already has
-- (account_id, created_at) from 0002.
CREATE INDEX idx_turn_started ON turn (started_at);

-- Import provenance and SHA-256 dedupe (FR-200, docs/08 §4.2). `import_id` groups the items of
-- one apply; `target` says what each became. Failed items never block a retry.
CREATE TABLE import_record (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('instruction_file', 'skill_folder',
    'command_file', 'plugin', 'mcp_config', 'project', 'memory_export', 'chat_export')),
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('instruction', 'skill', 'plugin', 'mcp_server',
    'project', 'memory', 'thread')),
  target_ref TEXT,
  target TEXT,
  status TEXT NOT NULL CHECK (status IN ('imported', 'disabled_pending_permissions', 'failed')),
  secrets_migrated INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_import_dedupe ON import_record (account_id, item_kind, sha256)
  WHERE status <> 'failed';
CREATE INDEX idx_import_record_account ON import_record (account_id, imported_at);
CREATE INDEX idx_import_record_import ON import_record (import_id);
