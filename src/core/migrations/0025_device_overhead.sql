-- The learned runtime overhead per device and backend (docs/plans/model-fit-adr-2026-11-04.md, "The
-- learned overhead"): what a real load showed the runtime takes beyond the model's weights and KV
-- cache (the CUDA or Metal context and compute buffers). The fit engine (models/fit.ts) moves it 30%
-- toward each reading from a load fully on the GPU, keeps it within 0.25–4 GB, and starts from the
-- 1.0 GB prior; the safety reserve is never learned, so it has no column here.
--
-- device_id is the device's own id; the hub's row uses the hub's device id, not the word "hub", so a
-- standby that takes over doesn't take the old hub's figure for its own GPU. The table is replicated
-- (owner direction, step 2b), so a hub that takes over plans models on every device with what was
-- measured, not with the prior again.
CREATE TABLE device_overhead (
  device_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('ollama')),
  learned_bytes INTEGER NOT NULL CHECK (learned_bytes BETWEEN 268435456 AND 4294967296),
  samples INTEGER NOT NULL DEFAULT 0 CHECK (samples >= 0),
  last_observed_bytes INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, backend)
);

CREATE TRIGGER sync_device_overhead_insert AFTER INSERT ON "device_overhead" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_overhead' AND pk = json_array(NEW."device_id", NEW."backend");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_overhead', json_array(NEW."device_id", NEW."backend"), 'put', json_object('device_id', NEW."device_id", 'backend', NEW."backend", 'learned_bytes', NEW."learned_bytes", 'samples', NEW."samples", 'last_observed_bytes', NEW."last_observed_bytes", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_overhead_update AFTER UPDATE ON "device_overhead" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_overhead' AND pk IN (json_array(OLD."device_id", OLD."backend"), json_array(NEW."device_id", NEW."backend"));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device_overhead', json_array(OLD."device_id", OLD."backend"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE json_array(OLD."device_id", OLD."backend") IS NOT json_array(NEW."device_id", NEW."backend");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_overhead', json_array(NEW."device_id", NEW."backend"), 'put', json_object('device_id', NEW."device_id", 'backend', NEW."backend", 'learned_bytes', NEW."learned_bytes", 'samples', NEW."samples", 'last_observed_bytes', NEW."last_observed_bytes", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_overhead_delete AFTER DELETE ON "device_overhead" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device_overhead' AND pk = json_array(OLD."device_id", OLD."backend");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device_overhead', json_array(OLD."device_id", OLD."backend"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
