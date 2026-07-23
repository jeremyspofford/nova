-- Migration 047: observability phase 3 — alert state
-- (docs/plans/observability-board.md, phase 3)
--
-- One open row per (instance, kind) is the de-dupe: the leader raises a row
-- + one notification on breach, then stays silent until the alert clears
-- (hysteresis) and breaches again. Cleared rows are kept briefly as the
-- board's recent-alerts trail; prune freely.

CREATE TABLE IF NOT EXISTS monitor_alerts (
    id          UUID PRIMARY KEY,
    instance_id TEXT NOT NULL,
    kind        TEXT NOT NULL,   -- disk_pct | mem_pct | vram_pct | gpu_temp_c | unreachable
    message     TEXT NOT NULL,
    value       REAL,
    threshold   REAL,
    raised_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    cleared_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_alerts_open_idx
    ON monitor_alerts (instance_id, kind) WHERE cleared_at IS NULL;
