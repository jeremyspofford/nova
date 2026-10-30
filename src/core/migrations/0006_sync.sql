-- Sync (M4c): what the standby needs to become the hub. Every write to a replicated table is
-- recorded in sync_log by the triggers below, with the whole row, so a standby that starts from
-- nothing and one that is a few rows behind read the same log. The log keeps only the newest entry
-- for each row (or file): an older one says nothing the newer one doesn't, and dropping it means a
-- forgotten memory's words don't linger in an old entry.
--
-- Never replicated: device_session, pairing, join_request (local to the node that issued them),
-- mesh_state and sync_state (this node's own place in the mesh), sync_log itself, schema_migrations,
-- and the identity files, which are not in the database at all.
--
-- Home files (workspace, conversations, MEMORY.md, schedules, skills …) are journalled into the same
-- log by src/core/mesh/sync.ts, as tbl 'file' with op file_put / file_delete.

CREATE TABLE sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  pk  TEXT NOT NULL,                     -- the row's key as text; a composite key is a JSON array
  op  TEXT NOT NULL CHECK (op IN ('put', 'delete', 'file_put', 'file_delete')),
  row TEXT,                              -- JSON: the whole row (put), the file (file_put), or null
  hlc TEXT NOT NULL                      -- wall-clock ms, a counter, the node that wrote it
);
CREATE UNIQUE INDEX sync_log_row ON sync_log (tbl, pk);

-- This node's side of sync: one row. logging is 1 on the hub, so local writes are recorded, and 0
-- on a standby, which copies the hub's log entries as they are (keeping the hub's seq). cursor is
-- the last hub seq a standby applied; acked_seq/acked_at is what the standby last told the hub.
CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logging INTEGER NOT NULL CHECK (logging IN (0, 1)),
  cursor INTEGER NOT NULL DEFAULT 0,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  acked_at TEXT,
  behind_since TEXT
);
INSERT INTO sync_state (id, logging) VALUES (1, 1);

-- profile
CREATE TRIGGER sync_profile_insert AFTER INSERT ON "profile" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'profile' AND pk = json_array(NEW."section", NEW."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('profile', json_array(NEW."section", NEW."key"), 'put', json_object('section', NEW."section", 'key', NEW."key", 'value', NEW."value", 'source', NEW."source", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_profile_update AFTER UPDATE ON "profile" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'profile' AND pk IN (json_array(OLD."section", OLD."key"), json_array(NEW."section", NEW."key"));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'profile', json_array(OLD."section", OLD."key"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE json_array(OLD."section", OLD."key") IS NOT json_array(NEW."section", NEW."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('profile', json_array(NEW."section", NEW."key"), 'put', json_object('section', NEW."section", 'key', NEW."key", 'value', NEW."value", 'source', NEW."source", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_profile_delete AFTER DELETE ON "profile" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'profile' AND pk = json_array(OLD."section", OLD."key");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('profile', json_array(OLD."section", OLD."key"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'profile', json_array("profile"."section", "profile"."key"), 'put', json_object('section', "profile"."section", 'key', "profile"."key", 'value', "profile"."value", 'source', "profile"."source", 'updated_at', "profile"."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "profile";

-- task
CREATE TRIGGER sync_task_insert AFTER INSERT ON "task" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'task' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('task', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'title', NEW."title", 'origin', NEW."origin", 'state', NEW."state", 'reason', NEW."reason", 'owner', NEW."owner", 'brief', NEW."brief", 'report', NEW."report", 'verification', NEW."verification", 'privacy_mode', NEW."privacy_mode", 'approval_tier', NEW."approval_tier", 'approved_at', NEW."approved_at", 'cost', NEW."cost", 'parent_id', NEW."parent_id", 'user_visibility', NEW."user_visibility", 'idempotency_key', NEW."idempotency_key", 'attempts', NEW."attempts", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at", 'completed_at', NEW."completed_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_task_update AFTER UPDATE ON "task" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'task' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'task', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('task', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'title', NEW."title", 'origin', NEW."origin", 'state', NEW."state", 'reason', NEW."reason", 'owner', NEW."owner", 'brief', NEW."brief", 'report', NEW."report", 'verification', NEW."verification", 'privacy_mode', NEW."privacy_mode", 'approval_tier', NEW."approval_tier", 'approved_at', NEW."approved_at", 'cost', NEW."cost", 'parent_id', NEW."parent_id", 'user_visibility', NEW."user_visibility", 'idempotency_key', NEW."idempotency_key", 'attempts', NEW."attempts", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at", 'completed_at', NEW."completed_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_task_delete AFTER DELETE ON "task" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'task' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('task', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'task', CAST("task"."id" AS TEXT), 'put', json_object('id', "task"."id", 'title', "task"."title", 'origin', "task"."origin", 'state', "task"."state", 'reason', "task"."reason", 'owner', "task"."owner", 'brief', "task"."brief", 'report', "task"."report", 'verification', "task"."verification", 'privacy_mode', "task"."privacy_mode", 'approval_tier', "task"."approval_tier", 'approved_at', "task"."approved_at", 'cost', "task"."cost", 'parent_id', "task"."parent_id", 'user_visibility', "task"."user_visibility", 'idempotency_key', "task"."idempotency_key", 'attempts', "task"."attempts", 'created_at', "task"."created_at", 'updated_at', "task"."updated_at", 'completed_at', "task"."completed_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "task";

-- task_event
CREATE TRIGGER sync_task_event_insert AFTER INSERT ON "task_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'task_event' AND pk = CAST(NEW."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('task_event', CAST(NEW."seq" AS TEXT), 'put', json_object('seq', NEW."seq", 'task_id', NEW."task_id", 'at', NEW."at", 'kind', NEW."kind", 'from_state', NEW."from_state", 'to_state', NEW."to_state", 'detail', NEW."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_task_event_update AFTER UPDATE ON "task_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'task_event' AND pk IN (CAST(OLD."seq" AS TEXT), CAST(NEW."seq" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'task_event', CAST(OLD."seq" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."seq" AS TEXT) IS NOT CAST(NEW."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('task_event', CAST(NEW."seq" AS TEXT), 'put', json_object('seq', NEW."seq", 'task_id', NEW."task_id", 'at', NEW."at", 'kind', NEW."kind", 'from_state', NEW."from_state", 'to_state', NEW."to_state", 'detail', NEW."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_task_event_delete AFTER DELETE ON "task_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'task_event' AND pk = CAST(OLD."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('task_event', CAST(OLD."seq" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'task_event', CAST("task_event"."seq" AS TEXT), 'put', json_object('seq', "task_event"."seq", 'task_id', "task_event"."task_id", 'at', "task_event"."at", 'kind', "task_event"."kind", 'from_state', "task_event"."from_state", 'to_state', "task_event"."to_state", 'detail', "task_event"."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "task_event";

-- memory
CREATE TRIGGER sync_memory_insert AFTER INSERT ON "memory" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'memory' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('memory', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'kind', NEW."kind", 'content', NEW."content", 'source', NEW."source", 'observed_at', NEW."observed_at", 'recorded_by', NEW."recorded_by", 'confidence', NEW."confidence", 'scope', NEW."scope", 'supersedes', NEW."supersedes", 'superseded_by', NEW."superseded_by", 'expires', NEW."expires", 'user_state', NEW."user_state", 'created_at', NEW."created_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_memory_update AFTER UPDATE ON "memory" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'memory' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'memory', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('memory', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'kind', NEW."kind", 'content', NEW."content", 'source', NEW."source", 'observed_at', NEW."observed_at", 'recorded_by', NEW."recorded_by", 'confidence', NEW."confidence", 'scope', NEW."scope", 'supersedes', NEW."supersedes", 'superseded_by', NEW."superseded_by", 'expires', NEW."expires", 'user_state', NEW."user_state", 'created_at', NEW."created_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_memory_delete AFTER DELETE ON "memory" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'memory' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('memory', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'memory', CAST("memory"."id" AS TEXT), 'put', json_object('id', "memory"."id", 'kind', "memory"."kind", 'content', "memory"."content", 'source', "memory"."source", 'observed_at', "memory"."observed_at", 'recorded_by', "memory"."recorded_by", 'confidence', "memory"."confidence", 'scope', "memory"."scope", 'supersedes', "memory"."supersedes", 'superseded_by', "memory"."superseded_by", 'expires', "memory"."expires", 'user_state', "memory"."user_state", 'created_at', "memory"."created_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "memory";

-- memory_event
CREATE TRIGGER sync_memory_event_insert AFTER INSERT ON "memory_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'memory_event' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('memory_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'kind', NEW."kind", 'memory_id', NEW."memory_id", 'by', NEW."by"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_memory_event_update AFTER UPDATE ON "memory_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'memory_event' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'memory_event', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('memory_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'kind', NEW."kind", 'memory_id', NEW."memory_id", 'by', NEW."by"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_memory_event_delete AFTER DELETE ON "memory_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'memory_event' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('memory_event', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'memory_event', CAST("memory_event"."id" AS TEXT), 'put', json_object('id', "memory_event"."id", 'at', "memory_event"."at", 'kind', "memory_event"."kind", 'memory_id', "memory_event"."memory_id", 'by', "memory_event"."by"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "memory_event";

-- decision_template
CREATE TRIGGER sync_decision_template_insert AFTER INSERT ON "decision_template" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'decision_template' AND pk = json_array(NEW."template_id", NEW."version");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('decision_template', json_array(NEW."template_id", NEW."version"), 'put', json_object('template_id', NEW."template_id", 'version', NEW."version", 'situation', NEW."situation", 'inputs', NEW."inputs", 'questions', NEW."questions", 'escalation', NEW."escalation", 'uses', NEW."uses", 'agreed', NEW."agreed", 'disagreed', NEW."disagreed", 'state', NEW."state", 'dry_runs', NEW."dry_runs", 'activation_task_id', NEW."activation_task_id", 'created_by', NEW."created_by", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_decision_template_update AFTER UPDATE ON "decision_template" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'decision_template' AND pk IN (json_array(OLD."template_id", OLD."version"), json_array(NEW."template_id", NEW."version"));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'decision_template', json_array(OLD."template_id", OLD."version"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE json_array(OLD."template_id", OLD."version") IS NOT json_array(NEW."template_id", NEW."version");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('decision_template', json_array(NEW."template_id", NEW."version"), 'put', json_object('template_id', NEW."template_id", 'version', NEW."version", 'situation', NEW."situation", 'inputs', NEW."inputs", 'questions', NEW."questions", 'escalation', NEW."escalation", 'uses', NEW."uses", 'agreed', NEW."agreed", 'disagreed', NEW."disagreed", 'state', NEW."state", 'dry_runs', NEW."dry_runs", 'activation_task_id', NEW."activation_task_id", 'created_by', NEW."created_by", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_decision_template_delete AFTER DELETE ON "decision_template" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'decision_template' AND pk = json_array(OLD."template_id", OLD."version");
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('decision_template', json_array(OLD."template_id", OLD."version"), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'decision_template', json_array("decision_template"."template_id", "decision_template"."version"), 'put', json_object('template_id', "decision_template"."template_id", 'version', "decision_template"."version", 'situation', "decision_template"."situation", 'inputs', "decision_template"."inputs", 'questions', "decision_template"."questions", 'escalation', "decision_template"."escalation", 'uses', "decision_template"."uses", 'agreed', "decision_template"."agreed", 'disagreed', "decision_template"."disagreed", 'state', "decision_template"."state", 'dry_runs', "decision_template"."dry_runs", 'activation_task_id', "decision_template"."activation_task_id", 'created_by', "decision_template"."created_by", 'created_at', "decision_template"."created_at", 'updated_at', "decision_template"."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "decision_template";

-- decision_template_event
CREATE TRIGGER sync_decision_template_event_insert AFTER INSERT ON "decision_template_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'decision_template_event' AND pk = CAST(NEW."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('decision_template_event', CAST(NEW."seq" AS TEXT), 'put', json_object('seq', NEW."seq", 'template_id', NEW."template_id", 'version', NEW."version", 'at', NEW."at", 'kind', NEW."kind", 'detail', NEW."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_decision_template_event_update AFTER UPDATE ON "decision_template_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'decision_template_event' AND pk IN (CAST(OLD."seq" AS TEXT), CAST(NEW."seq" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'decision_template_event', CAST(OLD."seq" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."seq" AS TEXT) IS NOT CAST(NEW."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('decision_template_event', CAST(NEW."seq" AS TEXT), 'put', json_object('seq', NEW."seq", 'template_id', NEW."template_id", 'version', NEW."version", 'at', NEW."at", 'kind', NEW."kind", 'detail', NEW."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_decision_template_event_delete AFTER DELETE ON "decision_template_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'decision_template_event' AND pk = CAST(OLD."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('decision_template_event', CAST(OLD."seq" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'decision_template_event', CAST("decision_template_event"."seq" AS TEXT), 'put', json_object('seq', "decision_template_event"."seq", 'template_id', "decision_template_event"."template_id", 'version', "decision_template_event"."version", 'at', "decision_template_event"."at", 'kind', "decision_template_event"."kind", 'detail', "decision_template_event"."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "decision_template_event";

-- trigger_rule
CREATE TRIGGER sync_trigger_rule_insert AFTER INSERT ON "trigger_rule" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger_rule' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger_rule', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'name', NEW."name", 'class', NEW."class", 'source', NEW."source", 'cron', NEW."cron", 'action', NEW."action", 'dedup_window_s', NEW."dedup_window_s", 'cooldown_s', NEW."cooldown_s", 'paused', NEW."paused", 'hook_token_hash', NEW."hook_token_hash", 'last_due_at', NEW."last_due_at", 'created_by', NEW."created_by", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_trigger_rule_update AFTER UPDATE ON "trigger_rule" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger_rule' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'trigger_rule', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger_rule', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'name', NEW."name", 'class', NEW."class", 'source', NEW."source", 'cron', NEW."cron", 'action', NEW."action", 'dedup_window_s', NEW."dedup_window_s", 'cooldown_s', NEW."cooldown_s", 'paused', NEW."paused", 'hook_token_hash', NEW."hook_token_hash", 'last_due_at', NEW."last_due_at", 'created_by', NEW."created_by", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_trigger_rule_delete AFTER DELETE ON "trigger_rule" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger_rule' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger_rule', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'trigger_rule', CAST("trigger_rule"."id" AS TEXT), 'put', json_object('id', "trigger_rule"."id", 'name', "trigger_rule"."name", 'class', "trigger_rule"."class", 'source', "trigger_rule"."source", 'cron', "trigger_rule"."cron", 'action', "trigger_rule"."action", 'dedup_window_s', "trigger_rule"."dedup_window_s", 'cooldown_s', "trigger_rule"."cooldown_s", 'paused', "trigger_rule"."paused", 'hook_token_hash', "trigger_rule"."hook_token_hash", 'last_due_at', "trigger_rule"."last_due_at", 'created_by', "trigger_rule"."created_by", 'created_at', "trigger_rule"."created_at", 'updated_at', "trigger_rule"."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "trigger_rule";

-- trigger_rule_event
CREATE TRIGGER sync_trigger_rule_event_insert AFTER INSERT ON "trigger_rule_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger_rule_event' AND pk = CAST(NEW."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger_rule_event', CAST(NEW."seq" AS TEXT), 'put', json_object('seq', NEW."seq", 'rule_id', NEW."rule_id", 'at', NEW."at", 'kind', NEW."kind", 'detail', NEW."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_trigger_rule_event_update AFTER UPDATE ON "trigger_rule_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger_rule_event' AND pk IN (CAST(OLD."seq" AS TEXT), CAST(NEW."seq" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'trigger_rule_event', CAST(OLD."seq" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."seq" AS TEXT) IS NOT CAST(NEW."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger_rule_event', CAST(NEW."seq" AS TEXT), 'put', json_object('seq', NEW."seq", 'rule_id', NEW."rule_id", 'at', NEW."at", 'kind', NEW."kind", 'detail', NEW."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_trigger_rule_event_delete AFTER DELETE ON "trigger_rule_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger_rule_event' AND pk = CAST(OLD."seq" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger_rule_event', CAST(OLD."seq" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'trigger_rule_event', CAST("trigger_rule_event"."seq" AS TEXT), 'put', json_object('seq', "trigger_rule_event"."seq", 'rule_id', "trigger_rule_event"."rule_id", 'at', "trigger_rule_event"."at", 'kind', "trigger_rule_event"."kind", 'detail', "trigger_rule_event"."detail"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "trigger_rule_event";

-- trigger
CREATE TRIGGER sync_trigger_insert AFTER INSERT ON "trigger" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger' AND pk = CAST(NEW."trigger_id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger', CAST(NEW."trigger_id" AS TEXT), 'put', json_object('trigger_id', NEW."trigger_id", 'rule_id', NEW."rule_id", 'class', NEW."class", 'source', NEW."source", 'payload_ref', NEW."payload_ref", 'triage', NEW."triage", 'dedup_key', NEW."dedup_key", 'claim_key', NEW."claim_key", 'cooldown_until', NEW."cooldown_until", 'ledger_task_id', NEW."ledger_task_id", 'message_id', NEW."message_id", 'at', NEW."at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_trigger_update AFTER UPDATE ON "trigger" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger' AND pk IN (CAST(OLD."trigger_id" AS TEXT), CAST(NEW."trigger_id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'trigger', CAST(OLD."trigger_id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."trigger_id" AS TEXT) IS NOT CAST(NEW."trigger_id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger', CAST(NEW."trigger_id" AS TEXT), 'put', json_object('trigger_id', NEW."trigger_id", 'rule_id', NEW."rule_id", 'class', NEW."class", 'source', NEW."source", 'payload_ref', NEW."payload_ref", 'triage', NEW."triage", 'dedup_key', NEW."dedup_key", 'claim_key', NEW."claim_key", 'cooldown_until', NEW."cooldown_until", 'ledger_task_id', NEW."ledger_task_id", 'message_id', NEW."message_id", 'at', NEW."at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_trigger_delete AFTER DELETE ON "trigger" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'trigger' AND pk = CAST(OLD."trigger_id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('trigger', CAST(OLD."trigger_id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'trigger', CAST("trigger"."trigger_id" AS TEXT), 'put', json_object('trigger_id', "trigger"."trigger_id", 'rule_id', "trigger"."rule_id", 'class', "trigger"."class", 'source', "trigger"."source", 'payload_ref', "trigger"."payload_ref", 'triage', "trigger"."triage", 'dedup_key', "trigger"."dedup_key", 'claim_key', "trigger"."claim_key", 'cooldown_until', "trigger"."cooldown_until", 'ledger_task_id', "trigger"."ledger_task_id", 'message_id', "trigger"."message_id", 'at', "trigger"."at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "trigger";

-- message
CREATE TRIGGER sync_message_insert AFTER INSERT ON "message" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'message' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('message', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'text', NEW."text", 'trigger_id', NEW."trigger_id", 'delivered_at', NEW."delivered_at", 'read_at', NEW."read_at", 'hold', NEW."hold"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_message_update AFTER UPDATE ON "message" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'message' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'message', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('message', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'text', NEW."text", 'trigger_id', NEW."trigger_id", 'delivered_at', NEW."delivered_at", 'read_at', NEW."read_at", 'hold', NEW."hold"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_message_delete AFTER DELETE ON "message" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'message' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('message', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'message', CAST("message"."id" AS TEXT), 'put', json_object('id', "message"."id", 'at', "message"."at", 'text', "message"."text", 'trigger_id', "message"."trigger_id", 'delivered_at', "message"."delivered_at", 'read_at', "message"."read_at", 'hold', "message"."hold"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "message";

-- extension
CREATE TRIGGER sync_extension_insert AFTER INSERT ON "extension" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'extension' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('extension', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'version', NEW."version", 'kind', NEW."kind", 'manifest', NEW."manifest", 'state', NEW."state", 'installed_at', NEW."installed_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_extension_update AFTER UPDATE ON "extension" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'extension' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'extension', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('extension', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'version', NEW."version", 'kind', NEW."kind", 'manifest', NEW."manifest", 'state', NEW."state", 'installed_at', NEW."installed_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_extension_delete AFTER DELETE ON "extension" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'extension' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('extension', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'extension', CAST("extension"."id" AS TEXT), 'put', json_object('id', "extension"."id", 'version', "extension"."version", 'kind', "extension"."kind", 'manifest', "extension"."manifest", 'state', "extension"."state", 'installed_at', "extension"."installed_at", 'updated_at', "extension"."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "extension";

-- device
CREATE TRIGGER sync_device_insert AFTER INSERT ON "device" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'name', NEW."name", 'platform', NEW."platform", 'kind', NEW."kind", 'role', NEW."role", 'public_key', NEW."public_key", 'x25519_public_key', NEW."x25519_public_key", 'fingerprint', NEW."fingerprint", 'capabilities', NEW."capabilities", 'trust', NEW."trust", 'can_approve', NEW."can_approve", 'address', NEW."address", 'created_at', NEW."created_at", 'approved_at', NEW."approved_at", 'revoked_at', NEW."revoked_at", 'revoked_reason', NEW."revoked_reason", 'last_seen', NEW."last_seen"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_update AFTER UPDATE ON "device" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'name', NEW."name", 'platform', NEW."platform", 'kind', NEW."kind", 'role', NEW."role", 'public_key', NEW."public_key", 'x25519_public_key', NEW."x25519_public_key", 'fingerprint', NEW."fingerprint", 'capabilities', NEW."capabilities", 'trust', NEW."trust", 'can_approve', NEW."can_approve", 'address', NEW."address", 'created_at', NEW."created_at", 'approved_at', NEW."approved_at", 'revoked_at', NEW."revoked_at", 'revoked_reason', NEW."revoked_reason", 'last_seen', NEW."last_seen"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_device_delete AFTER DELETE ON "device" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'device' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('device', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'device', CAST("device"."id" AS TEXT), 'put', json_object('id', "device"."id", 'name', "device"."name", 'platform', "device"."platform", 'kind', "device"."kind", 'role', "device"."role", 'public_key', "device"."public_key", 'x25519_public_key', "device"."x25519_public_key", 'fingerprint', "device"."fingerprint", 'capabilities', "device"."capabilities", 'trust', "device"."trust", 'can_approve', "device"."can_approve", 'address', "device"."address", 'created_at', "device"."created_at", 'approved_at', "device"."approved_at", 'revoked_at', "device"."revoked_at", 'revoked_reason', "device"."revoked_reason", 'last_seen', "device"."last_seen"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "device";

-- problem
CREATE TRIGGER sync_problem_insert AFTER INSERT ON "problem" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'problem' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('problem', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'source', NEW."source", 'message', NEW."message", 'detail', NEW."detail", 'task_id', NEW."task_id", 'resolved_at', NEW."resolved_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_problem_update AFTER UPDATE ON "problem" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'problem' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'problem', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('problem', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'source', NEW."source", 'message', NEW."message", 'detail', NEW."detail", 'task_id', NEW."task_id", 'resolved_at', NEW."resolved_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_problem_delete AFTER DELETE ON "problem" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'problem' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('problem', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'problem', CAST("problem"."id" AS TEXT), 'put', json_object('id', "problem"."id", 'at', "problem"."at", 'source', "problem"."source", 'message', "problem"."message", 'detail', "problem"."detail", 'task_id', "problem"."task_id", 'resolved_at', "problem"."resolved_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "problem";

-- receipt
CREATE TRIGGER sync_receipt_insert AFTER INSERT ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'context_items', NEW."context_items"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_receipt_update AFTER UPDATE ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'receipt', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'at', NEW."at", 'task_id', NEW."task_id", 'session_id', NEW."session_id", 'provider', NEW."provider", 'model', NEW."model", 'purpose', NEW."purpose", 'privacy_mode', NEW."privacy_mode", 'egress', NEW."egress", 'context_items', NEW."context_items"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_receipt_delete AFTER DELETE ON "receipt" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'receipt' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('receipt', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'receipt', CAST("receipt"."id" AS TEXT), 'put', json_object('id', "receipt"."id", 'at', "receipt"."at", 'task_id', "receipt"."task_id", 'session_id', "receipt"."session_id", 'provider', "receipt"."provider", 'model', "receipt"."model", 'purpose', "receipt"."purpose", 'privacy_mode', "receipt"."privacy_mode", 'egress', "receipt"."egress", 'context_items', "receipt"."context_items"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) FROM "receipt";
