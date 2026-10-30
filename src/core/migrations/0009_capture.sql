-- Capture (M6a, src/core/capture/): sources with their consent, the events they captured, what was
-- promoted into memory from them and what a triage decision proposed. All of it replicates to a
-- standby (M4c), so consent, the adapters' cursors and exactly-once survive a failover, and a delete
-- here is a delete there.
--
-- Captured words live in capture_event only (text, and the app, window title and address that can
-- say as much). Nothing else in this file copies them, so forgetting an event is deleting its row:
-- the sync log keeps a content-free delete, and backups are cleaned of the row (backups.ts).

-- A source: one adapter on one device. Off until the person turns it on (consent_at, consent_by).
CREATE TABLE capture_source (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('screenpipe', 'device')),
  name TEXT NOT NULL,
  kinds TEXT NOT NULL,                   -- JSON: the kinds it produces
  config TEXT NOT NULL DEFAULT '{}',     -- JSON: the adapter's settings ({url} for Screenpipe)
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  consent_at TEXT,
  consent_by TEXT,
  cursor TEXT,                           -- JSON: how far the adapter has read
  status TEXT NOT NULL DEFAULT 'off',
  status_detail TEXT,
  status_at TEXT,
  counts TEXT NOT NULL DEFAULT '{}',     -- JSON: how many were kept and dropped, and why (no content)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One normalized event. space is null while unclassified; space_by says which signal (or the
-- person) put it there.
CREATE TABLE capture_event (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screen', 'audio', 'meeting', 'browser', 'app-activity', 'sensor')),
  at TEXT NOT NULL,
  ended_at TEXT,
  received_at TEXT NOT NULL,
  app TEXT,
  window_title TEXT,
  url TEXT,
  text TEXT,
  space TEXT,
  space_by TEXT,
  external_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('pull', 'inbox', 'api')),
  consent_at TEXT NOT NULL,
  triaged INTEGER NOT NULL DEFAULT 0 CHECK (triaged IN (0, 1)),
  UNIQUE (source_id, external_id)
);
CREATE INDEX capture_event_at ON capture_event (at);
CREATE INDEX capture_event_space ON capture_event (space, at);

-- What a source already sent that was forgotten, by a hash of its own id, so pulling or sending it
-- again can't bring it back. No content.
CREATE TABLE capture_tombstone (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (source_id, key)
);

-- A memory made from captured events (CONTRACTS §7 provenance back to them): one row per event. It
-- outlives the event when retention sweeps it, carrying when and where it was captured, not what.
CREATE TABLE capture_promotion (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  proposal_id TEXT,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  event_at TEXT,
  event_kind TEXT,
  source_id TEXT,
  device_id TEXT
);
CREATE INDEX capture_promotion_memory ON capture_promotion (memory_id);
CREATE INDEX capture_promotion_event ON capture_promotion (event_id);

-- A triage decision may only propose: this is the proposal, until the person accepts or dismisses it.
CREATE TABLE capture_proposal (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  p REAL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'dismissed')),
  at TEXT NOT NULL,
  decided_at TEXT,
  memory_id TEXT
);
CREATE INDEX capture_proposal_event ON capture_proposal (event_id);

-- A device agent sends capture events through its inbox (M4b), exactly once: device_inbox's kind
-- check gains capture_event. SQLite can't change a CHECK in place, so the table is rebuilt with its
-- rows and sync triggers as 0007 made them; its sync log entries are untouched (same keys, rows).
DROP TRIGGER sync_device_inbox_insert;
DROP TRIGGER sync_device_inbox_update;
DROP TRIGGER sync_device_inbox_delete;
CREATE TABLE device_inbox_0009 (
  device_id TEXT NOT NULL REFERENCES device (id),
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'task_request', 'memory_note', 'config_change', 'capture_event')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'refused', 'rejected')),
  reason TEXT,
  ref TEXT,
  body TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, key)
);
INSERT INTO device_inbox_0009 (device_id, key, kind, status, reason, ref, body, created_at, received_at)
  SELECT device_id, key, kind, status, reason, ref, body, created_at, received_at FROM device_inbox;
DROP TABLE device_inbox;
ALTER TABLE device_inbox_0009 RENAME TO device_inbox;
CREATE INDEX device_inbox_received ON device_inbox (received_at);

-- device_inbox
CREATE TRIGGER sync_device_inbox_insert AFTER INSERT ON "device_inbox" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_inbox' AND pk = json_array(NEW."device_id", NEW."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_inbox', json_array(NEW."device_id", NEW."key"), 'put', json_object('device_id', NEW."device_id", 'key', NEW."key", 'kind', NEW."kind", 'status', NEW."status", 'reason', NEW."reason", 'ref', NEW."ref", 'body', NEW."body", 'created_at', NEW."created_at", 'received_at', NEW."received_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_inbox_update AFTER UPDATE ON "device_inbox" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_inbox' AND pk IN (json_array(OLD."device_id", OLD."key"), json_array(NEW."device_id", NEW."key"));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_inbox', json_array(OLD."device_id", OLD."key"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE json_array(OLD."device_id", OLD."key") IS NOT json_array(NEW."device_id", NEW."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_inbox', json_array(NEW."device_id", NEW."key"), 'put', json_object('device_id', NEW."device_id", 'key', NEW."key", 'kind', NEW."kind", 'status', NEW."status", 'reason', NEW."reason", 'ref', NEW."ref", 'body', NEW."body", 'created_at', NEW."created_at", 'received_at', NEW."received_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_inbox_delete AFTER DELETE ON "device_inbox" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_inbox' AND pk = json_array(OLD."device_id", OLD."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_inbox', json_array(OLD."device_id", OLD."key"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
-- capture_source
CREATE TRIGGER sync_capture_source_insert AFTER INSERT ON "capture_source" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_source' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_source', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'name', NEW."name", 'kinds', NEW."kinds", 'config', NEW."config", 'enabled', NEW."enabled", 'paused', NEW."paused", 'consent_at', NEW."consent_at", 'consent_by', NEW."consent_by", 'cursor', NEW."cursor", 'status', NEW."status", 'status_detail', NEW."status_detail", 'status_at', NEW."status_at", 'counts', NEW."counts", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_source_update AFTER UPDATE ON "capture_source" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_source' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_source', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_source', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'name', NEW."name", 'kinds', NEW."kinds", 'config', NEW."config", 'enabled', NEW."enabled", 'paused', NEW."paused", 'consent_at', NEW."consent_at", 'consent_by', NEW."consent_by", 'cursor', NEW."cursor", 'status', NEW."status", 'status_detail', NEW."status_detail", 'status_at', NEW."status_at", 'counts', NEW."counts", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_source_delete AFTER DELETE ON "capture_source" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_source' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_source', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
-- capture_event
CREATE TRIGGER sync_capture_event_insert AFTER INSERT ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'source_id', NEW."source_id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'kind', NEW."kind", 'at', NEW."at", 'ended_at', NEW."ended_at", 'received_at', NEW."received_at", 'app', NEW."app", 'window_title', NEW."window_title", 'url', NEW."url", 'text', NEW."text", 'space', NEW."space", 'space_by', NEW."space_by", 'external_id', NEW."external_id", 'via', NEW."via", 'consent_at', NEW."consent_at", 'triaged', NEW."triaged"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_event_update AFTER UPDATE ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_event', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'source_id', NEW."source_id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'kind', NEW."kind", 'at', NEW."at", 'ended_at', NEW."ended_at", 'received_at', NEW."received_at", 'app', NEW."app", 'window_title', NEW."window_title", 'url', NEW."url", 'text', NEW."text", 'space', NEW."space", 'space_by', NEW."space_by", 'external_id', NEW."external_id", 'via', NEW."via", 'consent_at', NEW."consent_at", 'triaged', NEW."triaged"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_event_delete AFTER DELETE ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
-- capture_promotion
CREATE TRIGGER sync_capture_promotion_insert AFTER INSERT ON "capture_promotion" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_promotion' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_promotion', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'memory_id', NEW."memory_id", 'event_id', NEW."event_id", 'proposal_id', NEW."proposal_id", 'by', NEW."by", 'at', NEW."at", 'event_at', NEW."event_at", 'event_kind', NEW."event_kind", 'source_id', NEW."source_id", 'device_id', NEW."device_id"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_promotion_update AFTER UPDATE ON "capture_promotion" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_promotion' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_promotion', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_promotion', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'memory_id', NEW."memory_id", 'event_id', NEW."event_id", 'proposal_id', NEW."proposal_id", 'by', NEW."by", 'at', NEW."at", 'event_at', NEW."event_at", 'event_kind', NEW."event_kind", 'source_id', NEW."source_id", 'device_id', NEW."device_id"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_promotion_delete AFTER DELETE ON "capture_promotion" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_promotion' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_promotion', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
-- capture_proposal
CREATE TRIGGER sync_capture_proposal_insert AFTER INSERT ON "capture_proposal" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_proposal' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_proposal', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'event_id', NEW."event_id", 'template_id', NEW."template_id", 'version', NEW."version", 'provider', NEW."provider", 'p', NEW."p", 'state', NEW."state", 'at', NEW."at", 'decided_at', NEW."decided_at", 'memory_id', NEW."memory_id"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_proposal_update AFTER UPDATE ON "capture_proposal" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_proposal' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_proposal', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_proposal', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'event_id', NEW."event_id", 'template_id', NEW."template_id", 'version', NEW."version", 'provider', NEW."provider", 'p', NEW."p", 'state', NEW."state", 'at', NEW."at", 'decided_at', NEW."decided_at", 'memory_id', NEW."memory_id"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_proposal_delete AFTER DELETE ON "capture_proposal" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_proposal' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_proposal', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
-- capture_tombstone
CREATE TRIGGER sync_capture_tombstone_insert AFTER INSERT ON "capture_tombstone" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_tombstone' AND pk = json_array(NEW."source_id", NEW."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_tombstone', json_array(NEW."source_id", NEW."key"), 'put', json_object('source_id', NEW."source_id", 'key', NEW."key", 'at', NEW."at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_tombstone_update AFTER UPDATE ON "capture_tombstone" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_tombstone' AND pk IN (json_array(OLD."source_id", OLD."key"), json_array(NEW."source_id", NEW."key"));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_tombstone', json_array(OLD."source_id", OLD."key"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE json_array(OLD."source_id", OLD."key") IS NOT json_array(NEW."source_id", NEW."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_tombstone', json_array(NEW."source_id", NEW."key"), 'put', json_object('source_id', NEW."source_id", 'key', NEW."key", 'at', NEW."at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_tombstone_delete AFTER DELETE ON "capture_tombstone" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_tombstone' AND pk = json_array(OLD."source_id", OLD."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_tombstone', json_array(OLD."source_id", OLD."key"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
