-- The change pipeline (M7 plan §1, ADR-9). One record per proposed change: what it is, who
-- proposed it, its tier, the stage it reached with the evidence of every stage, the canary, and
-- what was live before it (kept, so a rollback restores exactly that). The stages are also ledger
-- events on the change’s tasks. Records replicate to the standby like the ledger they belong to.
CREATE TABLE change_record (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('extension', 'design-system', 'config', 'template', 'trigger-rules')),
  target           TEXT NOT NULL,
  title            TEXT NOT NULL,
  version          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  artifact         TEXT NOT NULL,   -- JSON: the change itself (files only, never secrets)
  proposed_by      TEXT NOT NULL,   -- person | foundry | provider:<id>
  author           TEXT,            -- who wrote it, when that isn’t who proposed it (the foundry’s model)
  tier             INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  stage            TEXT NOT NULL,   -- the furthest stage reached (gates.ts STAGES), or proposed / refused
  state            TEXT NOT NULL,   -- checking | stopped | waiting | canary | live | rolled_back | refused | declined | replaced
  reason           TEXT,
  stages           TEXT NOT NULL,   -- JSON {stage: {ok, at, summary, evidence}}
  canary           TEXT,            -- JSON: scope, window, the probe runs
  previous         TEXT,            -- JSON: what was live before, restored by a rollback
  release          TEXT,            -- JSON: where the release files are and their commit
  check_task_id    TEXT,
  ship_task_id     TEXT,
  rollback_task_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX change_record_target ON change_record (target, created_at);
CREATE INDEX change_record_state ON change_record (state);

CREATE TRIGGER sync_change_record_insert AFTER INSERT ON "change_record" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'change_record' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('change_record', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'kind', NEW."kind", 'target', NEW."target", 'title', NEW."title", 'version', NEW."version", 'content_hash', NEW."content_hash", 'artifact', NEW."artifact", 'proposed_by', NEW."proposed_by", 'author', NEW."author", 'tier', NEW."tier", 'stage', NEW."stage", 'state', NEW."state", 'reason', NEW."reason", 'stages', NEW."stages", 'canary', NEW."canary", 'previous', NEW."previous", 'release', NEW."release", 'check_task_id', NEW."check_task_id", 'ship_task_id', NEW."ship_task_id", 'rollback_task_id', NEW."rollback_task_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_change_record_update AFTER UPDATE ON "change_record" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'change_record' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'change_record', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('change_record', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'kind', NEW."kind", 'target', NEW."target", 'title', NEW."title", 'version', NEW."version", 'content_hash', NEW."content_hash", 'artifact', NEW."artifact", 'proposed_by', NEW."proposed_by", 'author', NEW."author", 'tier', NEW."tier", 'stage', NEW."stage", 'state', NEW."state", 'reason', NEW."reason", 'stages', NEW."stages", 'canary', NEW."canary", 'previous', NEW."previous", 'release', NEW."release", 'check_task_id', NEW."check_task_id", 'ship_task_id', NEW."ship_task_id", 'rollback_task_id', NEW."rollback_task_id", 'created_at', NEW."created_at", 'updated_at', NEW."updated_at"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_change_record_delete AFTER DELETE ON "change_record" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'change_record' AND pk = CAST(OLD."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('change_record', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
