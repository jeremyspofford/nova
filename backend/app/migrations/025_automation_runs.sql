-- Migration 025: automation run history (roadmap #25).
-- record_run previously overwrote last_status/last_summary in place, so a
-- future success erased all trace of past failures. Every run now lands a
-- row here; retention is bounded in code (last 50 per automation).

CREATE TABLE IF NOT EXISTS automation_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id    UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status           TEXT NOT NULL,
    summary          TEXT NOT NULL DEFAULT '',
    started_at       TIMESTAMPTZ NOT NULL,
    duration_seconds REAL NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_runs_by_automation
    ON automation_runs (automation_id, started_at DESC);
