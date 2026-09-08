-- S9 scheduling: a TIMER is a row; a FIRING is one execution of it. The
-- scheduler (app/scheduler.py) claims due rows with FOR UPDATE SKIP LOCKED in
-- one short transaction — that claim IS the exactly-once guarantee, so two
-- ticks (or two processes) on one due row produce ONE firing — and runs each
-- firing outside the transaction, because a model turn must never hold a row
-- lock. Nothing here asks anyone for approval (owner ruling 2026-09-03).
--
-- kind: 'reminder' (delivery is code, no model), 'scheduled' (an instruction
-- run as a real model turn through chat._run_turn), 'job' (a code handler
-- bound by name in timers.JOBS — never routed to a model). A job row belongs
-- to nobody, every other row belongs to a person: the CHECK makes the pairing
-- unrepresentable rather than merely unwritten.
--
-- next_fire_at NULL means FINISHED (a once that fired) — never a flag that
-- could drift from the fact. A paused row keeps its instant so a resume of a
-- once still in the future keeps it; a repeat is recomputed on resume.
-- paused_at without a reason is refused by the CHECK: a pause always says why
-- (the owner's words from the page, or "paused after 5 consecutive failures").

CREATE TABLE timers (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id            uuid REFERENCES people (id) ON DELETE CASCADE,
    kind                 text NOT NULL CHECK (kind IN ('reminder', 'scheduled', 'job')),
    title                text NOT NULL,
    -- reminder:  {"message": str, "device": str|null}
    -- scheduled: {"instruction": str}
    -- job:       {"handler": str}
    payload              jsonb NOT NULL DEFAULT '{}',
    -- A validated schedule.py spec; the shape is closed there, not here.
    schedule             jsonb NOT NULL,
    -- The IANA zone the spec's wall times are computed in.
    timezone             text NOT NULL,
    -- Where a reminder/scheduled reply lands. NULL for jobs, and NULL once
    -- the conversation is gone — a firing then states it cannot land.
    conversation_id      uuid REFERENCES conversations (id) ON DELETE SET NULL,
    next_fire_at         timestamptz,
    paused_at            timestamptz,
    paused_reason        text,
    consecutive_failures int NOT NULL DEFAULT 0,
    created_via          text NOT NULL CHECK (created_via IN ('chat', 'page', 'system')),
    -- Provenance: the chat turn whose tool call created it, when there was one.
    created_turn_id      uuid REFERENCES turns (id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT timers_job_has_no_person CHECK ((kind = 'job') = (person_id IS NULL)),
    CONSTRAINT timers_pause_states_why CHECK (paused_at IS NULL OR paused_reason IS NOT NULL)
);

-- The tick's claim query: due, unpaused, unfinished rows in fire order.
CREATE INDEX timers_due ON timers (next_fire_at)
    WHERE paused_at IS NULL AND next_fire_at IS NOT NULL;

-- One row per job handler, as a database invariant: timers.ensure_jobs seeds a
-- missing JOBS row at every startup and this index is what makes that
-- idempotent — a second INSERT for the same handler is refused by postgres,
-- never by a lookup the seeder might race.
CREATE UNIQUE INDEX timers_one_row_per_job ON timers ((payload->>'handler')) WHERE kind = 'job';

CREATE TABLE timer_firings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    timer_id      uuid NOT NULL REFERENCES timers (id) ON DELETE CASCADE,
    -- The next_fire_at the row was claimed at: what this firing was FOR, even
    -- when it ran late (after a restart, say).
    scheduled_for timestamptz NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    status        text NOT NULL
                  CHECK (status IN ('running', 'ok', 'error', 'refused', 'interrupted')),
    reason        text,
    -- Every firing is a turn (traces.open_turn with the timer's kind).
    turn_id       uuid REFERENCES turns (id) ON DELETE SET NULL,
    -- {"chat": {"ok": bool, "reason"?: str},
    --  "devices": [{"name": str, "ok": bool, "reason"?: str}], "note"?: str}
    delivery      jsonb NOT NULL DEFAULT '{}',
    -- 'running' exactly while there is no ended_at — same idiom as
    -- eval_suite_runs: a firing cannot claim to have finished without saying
    -- when, nor carry an end time while still claiming to run.
    CONSTRAINT timer_firings_terminal_has_ended_at CHECK ((status = 'running') = (ended_at IS NULL)),
    -- error / refused / interrupted must say why. Never a silent failure.
    CONSTRAINT timer_firings_failure_states_why CHECK (status IN ('running', 'ok') OR reason IS NOT NULL)
);

-- The page's "firings for this timer, newest first" and the retention job.
CREATE INDEX timer_firings_timer ON timer_firings (timer_id, started_at DESC);
