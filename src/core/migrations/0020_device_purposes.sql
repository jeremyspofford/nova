-- Device roles (M10f, docs/plans/M10f.md §1): what a device is for, as labels beside its mesh role
-- (`role` stays client, spoke, standby or hub). `purposes` is a JSON list of thin-client,
-- hub-candidate, compute, storage, capture-source and general-server. A join request carries what
-- the device asked for; the person's approval decides what the record gets.
--
-- Devices paired before this (the ADR, Point 9): phones and browsers become thin clients; the standby
-- becomes a hub candidate with no new confirmation, its key already pinned through its tier-3 standby
-- enrollment; computers get no workload role until the person picks one, except what they already
-- do (a model role: compute; a capture source: capture source), so nothing that runs there stops; the hub holds hub-candidate and general-server, as it runs Nova and its services.
--
-- The device table is replicated (0006), so its triggers are made again with the new column. A standby
-- a release behind gets rows without it: the hub leaves out what the standby's schema doesn't have
-- (mesh/sync.ts ADDED_COLUMNS, review finding 3). The receipt triggers 0019 made leave opt_in out when
-- it is unset; they are made again to carry it always, so one mechanism covers both.
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
-- Computers already doing work keep it (review finding 2): one serving a model role has compute;
-- one with a capture source has capture source. Compute first, so the list stays in order.
UPDATE device SET purposes = json_insert(purposes, '$[#]', 'compute') WHERE kind = 'computer' AND role != 'hub'
  AND EXISTS (SELECT 1 FROM profile p WHERE p.section = 'models' AND p.key LIKE 'role.%' AND json_valid(p.value) AND json_extract(p.value, '$.device') = device.id);
UPDATE device SET purposes = json_insert(purposes, '$[#]', 'capture-source') WHERE kind = 'computer' AND role != 'hub'
  AND EXISTS (SELECT 1 FROM capture_source c WHERE c.device_id = device.id AND c.adapter = 'device');
UPDATE device SET purposes = '["hub-candidate"]' WHERE kind = 'standby';
UPDATE device SET purposes = '["hub-candidate","general-server"]' WHERE role = 'hub';


DROP TRIGGER sync_receipt_insert;
DROP TRIGGER sync_receipt_update;
CREATE TRIGGER sync_receipt_insert AFTER INSERT ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'opt_in', NEW."opt_in", 'context_items', NEW."context_items"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_receipt_update AFTER UPDATE ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'receipt', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'opt_in', NEW."opt_in", 'context_items', NEW."context_items"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
