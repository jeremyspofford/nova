-- Device roles (M10f, docs/plans/M10f.md §1): what a device is for, as labels beside its mesh role
-- (`role` stays client, spoke, standby or hub). `purposes` is a JSON list of thin-client,
-- hub-candidate, compute, storage, capture-source and general-server. A join request carries what
-- the device asked for; the person's approval decides what the record gets.
--
-- Devices paired before this (the ADR, Point 9): phones and browsers become thin clients; the standby
-- becomes a hub candidate with no new confirmation, its key already pinned through its tier-3 standby
-- enrollment; computers get no workload role until the person picks one (nothing runs on them, so
-- nothing moves); the hub holds hub-candidate and general-server, as it runs Nova and its services.
--
-- The device table is replicated (0006), so its triggers are made again with the new column.
ALTER TABLE device ADD COLUMN purposes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE join_request ADD COLUMN purposes TEXT NOT NULL DEFAULT '[]';

DROP TRIGGER sync_device_insert;
DROP TRIGGER sync_device_update;
DROP TRIGGER sync_device_delete;
CREATE TRIGGER sync_device_insert AFTER INSERT ON "device" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'name', NEW."name", 'platform', NEW."platform", 'kind', NEW."kind", 'role', NEW."role", 'public_key', NEW."public_key", 'x25519_public_key', NEW."x25519_public_key", 'fingerprint', NEW."fingerprint", 'capabilities', NEW."capabilities", 'trust', NEW."trust", 'can_approve', NEW."can_approve", 'address', NEW."address", 'created_at', NEW."created_at", 'approved_at', NEW."approved_at", 'revoked_at', NEW."revoked_at", 'revoked_reason', NEW."revoked_reason", 'last_seen', NEW."last_seen", 'purposes', NEW."purposes"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_update AFTER UPDATE ON "device" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'name', NEW."name", 'platform', NEW."platform", 'kind', NEW."kind", 'role', NEW."role", 'public_key', NEW."public_key", 'x25519_public_key', NEW."x25519_public_key", 'fingerprint', NEW."fingerprint", 'capabilities', NEW."capabilities", 'trust', NEW."trust", 'can_approve', NEW."can_approve", 'address', NEW."address", 'created_at', NEW."created_at", 'approved_at', NEW."approved_at", 'revoked_at', NEW."revoked_at", 'revoked_reason', NEW."revoked_reason", 'last_seen', NEW."last_seen", 'purposes', NEW."purposes"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_delete AFTER DELETE ON "device" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;

UPDATE device SET purposes = '["thin-client"]' WHERE kind IN ('phone', 'browser');
UPDATE device SET purposes = '["hub-candidate"]' WHERE kind = 'standby';
UPDATE device SET purposes = '["hub-candidate","general-server"]' WHERE role = 'hub';
