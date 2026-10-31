-- Whether a problem stops Nova (DESIGN-SYSTEM §1; owner decision 2026-10-31). The orb is red only
-- for these: work can't proceed, a dead-man's switch fired, or a security refusal. Every other problem
-- needs the person while Nova keeps running, and shows amber. Set where the problem is raised
-- (Log.problem's `stops`, or a playbook that stops Nova); a problem raised before this is 0, amber.
ALTER TABLE problem ADD COLUMN stops INTEGER NOT NULL DEFAULT 0 CHECK (stops IN (0, 1));

-- The problem's sync triggers copy the whole row, so they carry the new column too.
DROP TRIGGER sync_problem_insert;
DROP TRIGGER sync_problem_update;
DROP TRIGGER sync_problem_delete;
CREATE TRIGGER sync_problem_insert AFTER INSERT ON "problem" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'problem' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('problem', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'source', NEW."source", 'message', NEW."message", 'detail', NEW."detail", 'task_id', NEW."task_id", 'resolved_at', NEW."resolved_at", 'stops', NEW."stops"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_problem_update AFTER UPDATE ON "problem" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'problem' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'problem', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('problem', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'source', NEW."source", 'message', NEW."message", 'detail', NEW."detail", 'task_id', NEW."task_id", 'resolved_at', NEW."resolved_at", 'stops', NEW."stops"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_problem_delete AFTER DELETE ON "problem" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'problem' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('problem', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
