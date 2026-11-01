-- Capture screening, job 1 (owner decision INPUT-2026-10-31-CAPTURE-SCREENING-DECISION.md, ADR
-- docs/plans/decision-service.md §2.1; plan docs/plans/capture-screening-consumers.md): each captured
-- event's screening state, beside its words.
--   sensitivity           unscreened: taken in after Nova's own rules, not yet checked by a model;
--                         held: in the holding area, because no trusted model on this device could
--                         check it (owner decision, option B), until one can or retention ends;
--                         index | redact | hold | exclude: capture-sensitive's outcome, applied.
--                         Only index and redact may be triaged or remembered.
--   sensitivity_why       Nova's own words for the label and the notice (never a model's text).
--   sensitivity_decision  the decision_record id that decided it (that record isn't replicated).
--   sensitivity_detail    JSON provenance: template and version, the seat and pinned model that
--                         answered, its trust, the scores, what Nova's own rules redacted (kinds
--                         only, never a value) and the capture source.
--   sensitivity_at        when it was last decided.
--   sensitivity_tries     how many checks in a row a trusted model couldn't answer; past the limit
--                         the event isn't asked again and stays held until retention deletes it.
--   sensitivity_next      when a failed check may be tried again (backing off), or NULL.
-- Rows from before this are unscreened: the next capture pass checks them, Nova's own rules first.
--
-- capture_event is replicated (0009), so its triggers are made again with the new columns. A standby
-- a release behind gets rows without them: the hub leaves out what the standby's schema doesn't have
-- (mesh/sync.ts ADDED_COLUMNS[21]).
ALTER TABLE capture_event ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'unscreened' CHECK (sensitivity IN ('unscreened', 'held', 'index', 'redact', 'hold', 'exclude'));
ALTER TABLE capture_event ADD COLUMN sensitivity_why TEXT;
ALTER TABLE capture_event ADD COLUMN sensitivity_decision TEXT;
ALTER TABLE capture_event ADD COLUMN sensitivity_detail TEXT;
ALTER TABLE capture_event ADD COLUMN sensitivity_at TEXT;
ALTER TABLE capture_event ADD COLUMN sensitivity_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE capture_event ADD COLUMN sensitivity_next TEXT;
CREATE INDEX capture_event_sensitivity ON capture_event (sensitivity, at);

-- The content-hash cache (the owner's condition: "the content-hash cache from Part 3 applies"):
-- a decision made with a trusted model, kept for a while under a key that is an HMAC, with a key of
-- this home's own, of the capture source and the normalised words checked. The same words from the
-- same source aren't asked again within the window; the key never matches across sources and can't
-- be confirmed by guessing a short text without the home's key. No words are kept. Not replicated:
-- a standby that becomes hub checks again.
CREATE TABLE capture_screen_cache (
  key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  decision_id TEXT,
  detail TEXT NOT NULL,                  -- JSON: the decision's provenance (no words)
  at TEXT NOT NULL
);
CREATE INDEX capture_screen_cache_at ON capture_screen_cache (at);

-- One open proposal per event: overlapping triage passes can't propose an event twice. Older
-- duplicates (none are expected) keep the earliest.
DELETE FROM capture_proposal WHERE state = 'proposed' AND rowid NOT IN (SELECT MIN(rowid) FROM capture_proposal WHERE state = 'proposed' GROUP BY event_id);
CREATE UNIQUE INDEX capture_proposal_open ON capture_proposal (event_id) WHERE state = 'proposed';

DROP TRIGGER sync_capture_event_insert;
DROP TRIGGER sync_capture_event_update;
CREATE TRIGGER sync_capture_event_insert AFTER INSERT ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk = CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'source_id', NEW."source_id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'kind', NEW."kind", 'at', NEW."at", 'ended_at', NEW."ended_at", 'received_at', NEW."received_at", 'app', NEW."app", 'window_title', NEW."window_title", 'url', NEW."url", 'text', NEW."text", 'space', NEW."space", 'space_by', NEW."space_by", 'external_id', NEW."external_id", 'via', NEW."via", 'consent_at', NEW."consent_at", 'triaged', NEW."triaged", 'sensitivity', NEW."sensitivity", 'sensitivity_why', NEW."sensitivity_why", 'sensitivity_decision', NEW."sensitivity_decision", 'sensitivity_detail', NEW."sensitivity_detail", 'sensitivity_at', NEW."sensitivity_at", 'sensitivity_tries', NEW."sensitivity_tries", 'sensitivity_next', NEW."sensitivity_next"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
CREATE TRIGGER sync_capture_event_update AFTER UPDATE ON "capture_event" WHEN (SELECT logging FROM sync_state WHERE id = 1) = 1 BEGIN
  DELETE FROM sync_log WHERE tbl = 'capture_event' AND pk IN (CAST(OLD."id" AS TEXT), CAST(NEW."id" AS TEXT));
  INSERT INTO sync_log (tbl, pk, op, row, hlc) SELECT 'capture_event', CAST(OLD."id" AS TEXT), 'delete', NULL, printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')) WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT);
  INSERT INTO sync_log (tbl, pk, op, row, hlc) VALUES ('capture_event', CAST(NEW."id" AS TEXT), 'put', json_object('id', NEW."id", 'source_id', NEW."source_id", 'device_id', NEW."device_id", 'adapter', NEW."adapter", 'kind', NEW."kind", 'at', NEW."at", 'ended_at', NEW."ended_at", 'received_at', NEW."received_at", 'app', NEW."app", 'window_title', NEW."window_title", 'url', NEW."url", 'text', NEW."text", 'space', NEW."space", 'space_by', NEW."space_by", 'external_id', NEW."external_id", 'via', NEW."via", 'consent_at', NEW."consent_at", 'triaged', NEW."triaged", 'sensitivity', NEW."sensitivity", 'sensitivity_why', NEW."sensitivity_why", 'sensitivity_decision', NEW."sensitivity_decision", 'sensitivity_detail', NEW."sensitivity_detail", 'sensitivity_at', NEW."sensitivity_at", 'sensitivity_tries', NEW."sensitivity_tries", 'sensitivity_next', NEW."sensitivity_next"), printf('%015d-%04x-%s', CAST(unixepoch('subsec') * 1000 AS INTEGER), (IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'), 0) + 1) % 65536, IFNULL((SELECT hub_id FROM mesh_state WHERE id = 1), 'node')));
END;
