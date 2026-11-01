-- Native workloads on devices and the capture data path (M10h, docs/plans/M10h.md).
--
-- device_workload: what the hub assigns each device, per service (replicated: a promoted hub keeps
--   the assignments, and devices keep running what they run meanwhile).
--     want        alongside (deploy next to the live one, no traffic), live (promoted), stopped
--     previous    the version kept on the device for one step back
--     definition  the definition of `version`, as registered; previous_definition that of `previous`
-- device_workload_report: what each device last said about each version (its heartbeat). Heard on
--   this node; a hub that takes over hears it again at the next heartbeat.
-- device_workload_event: what happened, for the record a person reads (this node only).
CREATE TABLE device_workload (
  device_id TEXT NOT NULL REFERENCES device (id),
  service TEXT NOT NULL,
  version TEXT NOT NULL,
  want TEXT NOT NULL CHECK (want IN ('alongside', 'live', 'stopped')),
  previous TEXT,
  definition TEXT NOT NULL,
  previous_definition TEXT,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, service)
);
CREATE TABLE device_workload_report (
  device_id TEXT NOT NULL,
  service TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('installed', 'alongside', 'ready', 'live', 'kept', 'failed', 'rolled_back')),
  health INTEGER CHECK (health IN (0, 1)),
  since TEXT NOT NULL,
  said TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (device_id, service, version)
);
CREATE TABLE device_workload_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  service TEXT NOT NULL,
  version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  said TEXT,
  at TEXT NOT NULL
);
CREATE INDEX device_workload_event_service ON device_workload_event (service, seq);

-- Provenance of a captured event (the design's "every transfer states its machine"): JSON with the
-- origin device and its name, the capture source (screenpipe-adapter, native), the device's sequence
-- number, the batch it came in, the device's time and the hub's receipt time. Null for capture taken
-- in before this (the hub's own Screenpipe, the inbox). capture_event is replicated (0009), so its
-- triggers are made again with the column; a standby a release behind gets rows without it
-- (mesh/sync.ts ADDED_COLUMNS[23]).
ALTER TABLE capture_event ADD COLUMN provenance TEXT;

-- Each batch a device sent, as verified: its manifest's SHA-256 and signature, the device, the
-- source and the sequence range (replicated, so the transfer history survives a failover). The
-- items' own checksums aren't kept: a forgotten item leaves no hash of its words behind.
CREATE TABLE capture_batch (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  seq_from INTEGER NOT NULL,
  seq_to INTEGER NOT NULL,
  items INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX capture_batch_device ON capture_batch (device_id, received_at);

-- A forget reaching a device that holds the item (derived in its queue, raw in its capture store):
-- items are the device's own ids for what to delete, events the hub's ids that were forgotten. The
-- forget reports "deleted everywhere" only once acked_at is set (replicated, so a hub that takes over
-- still waits for the acknowledgement).
CREATE TABLE capture_device_tombstone (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  items TEXT NOT NULL,
  events TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  acked_at TEXT,
  removed TEXT
);
CREATE INDEX capture_device_tombstone_pending ON capture_device_tombstone (device_id, acked_at);

-- How far each device's capture has synced: the last sequence the hub answered, the newest capture
-- time among them, and what the device said was still waiting (and why, if it is paused). Rebuilt
-- from the next batch on a hub that takes over, so it stays on this node.
CREATE TABLE capture_device_sync (
  device_id TEXT PRIMARY KEY,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  synced_to TEXT,
  queued INTEGER NOT NULL DEFAULT 0,
  paused TEXT,
  at TEXT NOT NULL
);

-- A raw item fetched from a device because the person asked, with the reason (its ledger task is the
-- record that replicates). The file is in the home, capture/raw/<id>, checked against the device's
-- signed checksum.
CREATE TABLE capture_raw_fetch (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  item TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('asked', 'arrived', 'failed')),
  sha256 TEXT,
  size INTEGER,
  signature TEXT,
  asked_at TEXT NOT NULL,
  done_at TEXT
);

DROP TRIGGER sync_capture_event_insert;
DROP TRIGGER sync_capture_event_update;
CREATE TRIGGER sync_capture_event_insert AFTER INSERT ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'source_id', NEW."source_id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'kind', NEW."kind", 'at', NEW."at", 'ended_at', NEW."ended_at", 'received_at', NEW."received_at", 'app', NEW."app", 'window_title', NEW."window_title", 'url', NEW."url", 'text', NEW."text", 'space', NEW."space", 'space_by', NEW."space_by", 'external_id', NEW."external_id", 'via', NEW."via", 'consent_at', NEW."consent_at", 'triaged', NEW."triaged", 'sensitivity', NEW."sensitivity", 'sensitivity_why', NEW."sensitivity_why", 'sensitivity_decision', NEW."sensitivity_decision", 'sensitivity_detail', NEW."sensitivity_detail", 'sensitivity_at', NEW."sensitivity_at", 'sensitivity_tries', NEW."sensitivity_tries", 'sensitivity_next', NEW."sensitivity_next", 'provenance', NEW."provenance"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_event_update AFTER UPDATE ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_event', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'source_id', NEW."source_id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'kind', NEW."kind", 'at', NEW."at", 'ended_at', NEW."ended_at", 'received_at', NEW."received_at", 'app', NEW."app", 'window_title', NEW."window_title", 'url', NEW."url", 'text', NEW."text", 'space', NEW."space", 'space_by', NEW."space_by", 'external_id', NEW."external_id", 'via', NEW."via", 'consent_at', NEW."consent_at", 'triaged', NEW."triaged", 'sensitivity', NEW."sensitivity", 'sensitivity_why', NEW."sensitivity_why", 'sensitivity_decision', NEW."sensitivity_decision", 'sensitivity_detail', NEW."sensitivity_detail", 'sensitivity_at', NEW."sensitivity_at", 'sensitivity_tries', NEW."sensitivity_tries", 'sensitivity_next', NEW."sensitivity_next", 'provenance', NEW."provenance"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;

CREATE TRIGGER sync_device_workload_insert AFTER INSERT ON "device_workload" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_workload' AND pk = json_array(NEW."device_id", NEW."service");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_workload', json_array(NEW."device_id", NEW."service"), 'put', json_object('device_id', NEW."device_id", 'service', NEW."service", 'version', NEW."version", 'want', NEW."want", 'previous', NEW."previous", 'definition', NEW."definition", 'previous_definition', NEW."previous_definition", 'assigned_at', NEW."assigned_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_workload_update AFTER UPDATE ON "device_workload" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_workload' AND pk IN (json_array(OLD."device_id", OLD."service"), json_array(NEW."device_id", NEW."service"));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_workload', json_array(OLD."device_id", OLD."service"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE json_array(OLD."device_id", OLD."service") IS NOT json_array(NEW."device_id", NEW."service");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_workload', json_array(NEW."device_id", NEW."service"), 'put', json_object('device_id', NEW."device_id", 'service', NEW."service", 'version', NEW."version", 'want', NEW."want", 'previous', NEW."previous", 'definition', NEW."definition", 'previous_definition', NEW."previous_definition", 'assigned_at', NEW."assigned_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_workload_delete AFTER DELETE ON "device_workload" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_workload' AND pk = json_array(OLD."device_id", OLD."service");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_workload', json_array(OLD."device_id", OLD."service"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;

CREATE TRIGGER sync_capture_batch_insert AFTER INSERT ON "capture_batch" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_batch' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_batch', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'source', NEW."source", 'seq_from', NEW."seq_from", 'seq_to', NEW."seq_to", 'items', NEW."items", 'manifest_sha256', NEW."manifest_sha256", 'signature', NEW."signature", 'received_at', NEW."received_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_batch_update AFTER UPDATE ON "capture_batch" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_batch' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_batch', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_batch', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'source', NEW."source", 'seq_from', NEW."seq_from", 'seq_to', NEW."seq_to", 'items', NEW."items", 'manifest_sha256', NEW."manifest_sha256", 'signature', NEW."signature", 'received_at', NEW."received_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_batch_delete AFTER DELETE ON "capture_batch" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_batch' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_batch', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;

CREATE TRIGGER sync_capture_device_tombstone_insert AFTER INSERT ON "capture_device_tombstone" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_device_tombstone' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_device_tombstone', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'items', NEW."items", 'events', NEW."events", 'issued_at', NEW."issued_at", 'acked_at', NEW."acked_at", 'removed', NEW."removed"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_device_tombstone_update AFTER UPDATE ON "capture_device_tombstone" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_device_tombstone' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_device_tombstone', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_device_tombstone', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'items', NEW."items", 'events', NEW."events", 'issued_at', NEW."issued_at", 'acked_at', NEW."acked_at", 'removed', NEW."removed"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_device_tombstone_delete AFTER DELETE ON "capture_device_tombstone" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_device_tombstone' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_device_tombstone', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
