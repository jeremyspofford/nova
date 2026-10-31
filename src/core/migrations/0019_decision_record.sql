-- The Decision Service's record (DS1, docs/plans/ds1.md NOTE 5; ADR docs/plans/decision-service.md
-- §3): one row per decision. Not replicated: it holds no content, only the state's hash and field
-- names, probabilities, the policy outcome and why. A task's timeline lists its records by task_id.
CREATE TABLE decision_record (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, task_id TEXT, subsystem TEXT NOT NULL,
  template_id TEXT NOT NULL, version INTEGER NOT NULL,
  seat TEXT NOT NULL, model_asked TEXT, model TEXT,
  privacy_mode TEXT NOT NULL, egress TEXT NOT NULL, opt_in TEXT,
  state_sha256 TEXT NOT NULL, state_fields TEXT NOT NULL,          -- JSON array of names
  pieces INTEGER NOT NULL, requests INTEGER NOT NULL, usage TEXT NOT NULL,
  answers TEXT, bands TEXT, shadows TEXT NOT NULL, failures TEXT NOT NULL,   -- JSON
  outcome TEXT NOT NULL, action TEXT NOT NULL, tier INTEGER NOT NULL,
  autonomy TEXT NOT NULL, quality TEXT NOT NULL, trust TEXT NOT NULL,
  verdict_ref TEXT, why TEXT NOT NULL
);
CREATE INDEX decision_record_task ON decision_record (task_id);
CREATE INDEX decision_record_template ON decision_record (template_id, version, at);

-- A receipt names the person's opt-in that allowed a remote call in a local mode (owner decision 1:
-- the screening opt-in sends screening to Jev even in local-only). Receipts are replicated, so the
-- sync triggers carry the new column too: only when it is set, so a standby one release behind
-- (which has no such column) takes every other receipt as before; a newer standby leaves out a
-- column it doesn't have (mesh/sync.ts).
ALTER TABLE receipt ADD COLUMN opt_in TEXT CHECK (opt_in IS NULL OR opt_in IN ('screening', 'box'));
DROP TRIGGER sync_receipt_insert;
DROP TRIGGER sync_receipt_update;
CREATE TRIGGER sync_receipt_insert AFTER INSERT ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(NEW."id" AS TEXT), 'put', CASE WHEN NEW."opt_in" IS NULL THEN json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'context_items', NEW."context_items") ELSE json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'opt_in', NEW."opt_in", 'context_items', NEW."context_items") END, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_receipt_update AFTER UPDATE ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'receipt', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(NEW."id" AS TEXT), 'put', CASE WHEN NEW."opt_in" IS NULL THEN json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'context_items', NEW."context_items") ELSE json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'opt_in', NEW."opt_in", 'context_items', NEW."context_items") END, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
