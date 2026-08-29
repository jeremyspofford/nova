-- Serves GET /api/v1/activity (services/core/app/activity.py): the list
-- orders newest-first by (started_at DESC, id DESC) and pages with
-- WHERE (started_at, id) < (cursor). Without this index that query is a
-- sequential scan + sort of the entire turns table on every request — a
-- cost that only grows as heartbeat/automation turns accumulate. A plain
-- ascending btree serves the DESC query too: postgres scans it backwards
-- just as efficiently as forwards.
CREATE INDEX turns_started_at_id ON turns (started_at, id);
