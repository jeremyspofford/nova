-- Wake-on-LAN inference nodes (docs/plans/wol-inference-nodes-adr-2026-11-06.md, "Security" and
-- "Inventory additions"). Every wake attempt, sent or refused, keeps who asked for it (origin: routing
-- or person), which of the hub's cards sent it (sender) and, for a refused or failed one, why (reason).
-- Refused attempts are rows too (outcome 'refused'), so the rate limits are counted from this table.
--
-- Both tables now replicate: a hub that takes over has a sleeping device's network cards and its wake
-- history, so it can wake it, and the rate limits survive a failover or a restart. Rows already here
-- are put into the log once, as 0006 did for the first replicated tables.
ALTER TABLE device_wake ADD COLUMN origin TEXT;
ALTER TABLE device_wake ADD COLUMN sender TEXT;
ALTER TABLE device_wake ADD COLUMN reason TEXT;
CREATE INDEX device_wake_sent ON device_wake (sent_at);

CREATE TRIGGER sync_device_hardware_insert AFTER INSERT ON "device_hardware" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_hardware' AND pk = NEW."device_id";
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_hardware', NEW."device_id", 'put', json_object('device_id', NEW."device_id", 'hardware', NEW."hardware", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_hardware_update AFTER UPDATE ON "device_hardware" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_hardware' AND pk IN (OLD."device_id", NEW."device_id");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_hardware', OLD."device_id", 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE OLD."device_id" IS NOT NEW."device_id";
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_hardware', NEW."device_id", 'put', json_object('device_id', NEW."device_id", 'hardware', NEW."hardware", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_hardware_delete AFTER DELETE ON "device_hardware" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_hardware' AND pk = OLD."device_id";
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_hardware', OLD."device_id", 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_hardware', "device_hardware"."device_id", 'put', json_object('device_id', "device_hardware"."device_id", 'hardware', "device_hardware"."hardware", 'updated_at', "device_hardware"."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "device_hardware" WHERE (SELECT logging FROM sync_state WHERE id = 1) = 1;

CREATE TRIGGER sync_device_wake_insert AFTER INSERT ON "device_wake" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_wake' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_wake', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'sent_at', NEW."sent_at", 'awake_at', NEW."awake_at", 'waited_ms', NEW."waited_ms", 'outcome', NEW."outcome", 'origin', NEW."origin", 'sender', NEW."sender", 'reason', NEW."reason"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_wake_update AFTER UPDATE ON "device_wake" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_wake' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_wake', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_wake', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'device_id', NEW."device_id", 'sent_at', NEW."sent_at", 'awake_at', NEW."awake_at", 'waited_ms', NEW."waited_ms", 'outcome', NEW."outcome", 'origin', NEW."origin", 'sender', NEW."sender", 'reason', NEW."reason"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_wake_delete AFTER DELETE ON "device_wake" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_wake' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_wake', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_wake', CAST("device_wake"."id" AS TEXT), 'put', json_object('id', "device_wake"."id", 'device_id', "device_wake"."device_id", 'sent_at', "device_wake"."sent_at", 'awake_at', "device_wake"."awake_at", 'waited_ms', "device_wake"."waited_ms", 'outcome', "device_wake"."outcome", 'origin', "device_wake"."origin", 'sender', "device_wake"."sender", 'reason', "device_wake"."reason"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "device_wake" WHERE (SELECT logging FROM sync_state WHERE id = 1) = 1;
