-- Migration 005: schedules table + schedule_id FK on tasks

CREATE TABLE IF NOT EXISTS schedules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    prompt      text NOT NULL,
    trigger     jsonb NOT NULL,
    enabled     bool NOT NULL DEFAULT true,
    created_by  text NOT NULL DEFAULT 'user',
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_fired  timestamptz,
    next_fire   timestamptz,
    fire_count  int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_schedules_next_fire
    ON schedules (next_fire)
    WHERE enabled = true AND next_fire IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_schedules_trigger_type
    ON schedules ((trigger->>'type'));

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES schedules(id);
