-- 0033 — M7 sync (FR-109, FR-112, FR-129; docs/13 §2, ADR-010, ADR-036, ADR-095 decisions 1-2).
-- The Hub is canonical. Every synced field of a thread, message, project, memory item, space,
-- page, schedule or global setting has one row in `sync_field` holding its current value, its hybrid
-- logical clock and the change-feed cursor of its last change; a replica pulls the rows after its
-- cursor. Deletes are tombstones (field `_deleted`). Values a last-writer-wins merge overwrote are
-- kept in `sync_merge_entry` for restore. `idempotency_key` keeps the first answer to a request
-- that carried an `Idempotency-Key` for 24 hours (FR-112). All timestamps UTC ISO-8601, ids UUIDv7.

-- The Hub's own clock and counters: `hlc` (the last HLC issued, so the clock never goes back
-- across restarts), `cursor` (the last change-feed cursor) and `message_watermark` (the sweep's
-- progress through message rows).
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The change feed. Entity ids are the entities' own ids (a setting's is its key). `parent_id` is
-- the thread of a message, so a thread's tombstone can drop its messages' rows. `device_id` is
-- the device whose op set the value (plain TEXT: the row outlives the device), null for a change
-- made on the Hub. `value_json` is JSON (`null` included). `cursor` is unique and only grows.
CREATE TABLE sync_field (
  kind TEXT NOT NULL
    CHECK (kind IN ('thread', 'message', 'project', 'memory', 'space', 'page', 'schedule',
      'setting')),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES account (id),
  parent_id TEXT,
  value_json TEXT NOT NULL,
  hlc TEXT NOT NULL,
  device_id TEXT,
  cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, field)
);
CREATE UNIQUE INDEX idx_sync_field_cursor ON sync_field (cursor);
CREATE INDEX idx_sync_field_account ON sync_field (account_id, cursor);
CREATE INDEX idx_sync_field_parent ON sync_field (kind, parent_id);

-- The merge log (Settings → Sync → History): the value that lost, the value that won, their
-- clocks and devices. `concurrent`: a newer op replaced a value its device had not seen; `stale`:
-- an op lost to a newer value; `restore`: a restore replaced the value. Restoring writes the lost
-- value as a new change.
CREATE TABLE sync_merge_entry (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL
    CHECK (kind IN ('thread', 'message', 'project', 'memory', 'space', 'page', 'schedule',
      'setting')),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('concurrent', 'stale', 'restore')),
  lost_value_json TEXT NOT NULL,
  lost_hlc TEXT NOT NULL,
  lost_device_id TEXT,
  winner_value_json TEXT NOT NULL,
  winner_hlc TEXT NOT NULL,
  winner_device_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'restored')),
  restored_at TEXT,
  restored_hlc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sync_merge_account ON sync_merge_entry (account_id, created_at);
CREATE INDEX idx_sync_merge_entity ON sync_merge_entry (kind, entity_id);

-- A device's replica: what it pulled last (`cursor`), when it last pulled and pushed, its last
-- error, and when the owner reset it (it must load a snapshot again) or it was revoked.
CREATE TABLE sync_replica (
  device_id TEXT PRIMARY KEY REFERENCES device (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  cursor INTEGER NOT NULL DEFAULT 0,
  last_pull_at TEXT,
  last_push_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  reset_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sync_replica_account ON sync_replica (account_id);

-- Idempotent writes (FR-112, decision 2): the first answer to a mutating request with an
-- `Idempotency-Key`, per principal (`device:<id>` for a device session, else `token:<id>`), key,
-- method and path. `status` is null while the first request runs. `body_hash` is hex SHA-256 of
-- the request body; a different body with the same key is refused. A response marked `no-store`
-- or larger than 256 KiB is not kept (`replayable` 0): a repeat is refused instead of replayed.
CREATE TABLE idempotency_key (
  principal TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  account_id TEXT,
  body_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  content_type TEXT,
  replayable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal, key, method, path)
);
CREATE INDEX idx_idempotency_key_expires ON idempotency_key (expires_at);
