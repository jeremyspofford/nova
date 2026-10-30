-- M4b's device-agent tables, as a numbered migration (src/core/mesh/spokes.ts made them with
-- CREATE TABLE IF NOT EXISTS before there was a number for them; on such a home this changes nothing).
-- device_inbox is replicated (M4c): it is what makes a device's queued items exactly-once, so it must
-- survive a failover with the registry. device_heartbeat is how a device was last heard from on this
-- node, and stays here.
CREATE TABLE IF NOT EXISTS device_inbox (
  device_id TEXT NOT NULL REFERENCES device (id),
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'task_request', 'memory_note', 'config_change')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'refused', 'rejected')),
  reason TEXT,
  ref TEXT,
  body TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, key)
);
CREATE INDEX IF NOT EXISTS device_inbox_received ON device_inbox (received_at);
CREATE TABLE IF NOT EXISTS device_heartbeat (
  device_id TEXT PRIMARY KEY REFERENCES device (id),
  version TEXT,
  runtime_version TEXT,
  safe_mode INTEGER NOT NULL DEFAULT 0 CHECK (safe_mode IN (0, 1)),
  at TEXT NOT NULL
);

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
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_inbox', json_array("device_inbox"."device_id", "device_inbox"."key"), 'put', json_object('device_id', "device_inbox"."device_id", 'key', "device_inbox"."key", 'kind', "device_inbox"."kind", 'status', "device_inbox"."status", 'reason', "device_inbox"."reason", 'ref', "device_inbox"."ref", 'body', "device_inbox"."body", 'created_at', "device_inbox"."created_at", 'received_at', "device_inbox"."received_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "device_inbox" WHERE (SELECT logging FROM sync_state WHERE id = 1) = 1;
