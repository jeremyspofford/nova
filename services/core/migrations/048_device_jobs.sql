-- S30c (jobs that outlive a turn): her jobs on her machines as rows
-- (docs/plans/rebuild/doing-things.md S30, app/device_jobs.py, one writer).
--
-- The next free number after 046_code_repos; S32.3's landings table takes
-- 048 (s32/spec.md §5.3).
--
-- A row is written by device_job_start BEFORE job.start goes on the wire
-- (state 'starting', the turn that started it), and its terminal record
-- comes from the agent's `job` frame (devices_ws -> apply_frame), applied
-- only to that device's own row while the device is still at the socket's
-- audit epoch. The agent's record on disk is the truth; this is core's copy.
--
-- Env VALUES never reach this table: env_keys holds names, and the CHECK
-- below is the line that refuses a `NAME=value` (or anything that is not a
-- name) whatever code tried to write it.
--
-- Re-runnable: its test executes it a second time.

-- Every element a name (^[A-Za-z_][A-Za-z0-9_]*$): no NULL, no empty string,
-- no `=`, no space. A function because a CHECK cannot hold a subquery.
CREATE OR REPLACE FUNCTION device_job_env_keys_ok(keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(bool_and(k IS NOT NULL AND k ~ '^[A-Za-z_][A-Za-z0-9_]*$'), true)
    FROM unnest(keys) AS k
$$;

CREATE TABLE IF NOT EXISTS device_jobs (
    -- core-generated, 12 lowercase hex — the agent's job dir name
    id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{12}$'),
    device_id   uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    -- the turn that started it (provenance, never a principal)
    turn_id     uuid REFERENCES turns (id) ON DELETE SET NULL,
    argv        jsonb NOT NULL
                CHECK (jsonb_typeof(argv) = 'array' AND jsonb_array_length(argv) > 0),
    cwd         text,
    env_keys    text[] NOT NULL DEFAULT '{}' CHECK (device_job_env_keys_ok(env_keys)),
    ran_in      text NOT NULL CHECK (ran_in IN ('host', 'box')),
    -- the box container (nova-box-<id>) when ran_in = 'box'
    box         text,
    state       text NOT NULL DEFAULT 'starting' CHECK (state IN (
        'starting', 'running', 'waiting_lock', 'done', 'failed_to_start', 'stopped', 'lost'
    )),
    exit_code   integer,
    reason      text,
    started_at  timestamptz,
    ended_at    timestamptz,
    log_bytes   bigint CHECK (log_bytes >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_jobs_by_device
    ON device_jobs (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_jobs_by_turn
    ON device_jobs (turn_id) WHERE turn_id IS NOT NULL;
