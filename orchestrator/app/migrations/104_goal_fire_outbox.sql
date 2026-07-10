-- 104_goal_fire_outbox.sql
-- Transactional outbox for scheduled-goal fires (cron durability).
--
-- Before this, cortex's scheduler advanced goals.schedule_next_at and bumped
-- completion_count BEFORE the scheduled work was durable (see the old
-- check_schedules()). A crash between "advance the clock" and "dispatch the
-- work" silently dropped the fire — the Morning Briefing just wouldn't happen,
-- with no retry and no trace. At-most-once with a data-loss window, when a
-- scheduled job wants at-least-once.
--
-- Now cortex records a durable fire row here in the SAME transaction that
-- advances the clock (cortex/app/scheduler.py:enqueue_due_fires). A separate
-- drain step (drain_outbox → cycle stimuli → ack_fires) processes pending fires
-- and only marks them 'done' AFTER the cycle handled them, so a crash mid-cycle
-- redelivers instead of losing the fire. Duplicate delivery (the tail of
-- at-least-once) is bounded by the tool-idempotency ledger (migration 103) for
-- side effects, and by the UNIQUE (goal_id, fire_at) guard below for enqueue.

CREATE TABLE IF NOT EXISTS goal_fire_outbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goal_id       UUID NOT NULL,
    title         TEXT,                       -- snapshot for the stimulus payload
    priority      INTEGER,                    -- snapshot for drive scoring
    fire_at       TIMESTAMPTZ NOT NULL,       -- the scheduled instant this fire represents
    status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'failed'
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at TIMESTAMPTZ,
    -- One fire per scheduled instant: makes enqueue idempotent, so a double
    -- check (two cortex loops, or a retry) can't duplicate a fire.
    UNIQUE (goal_id, fire_at)
);

-- Drain reads pending fires oldest-first; partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_goal_fire_outbox_pending
    ON goal_fire_outbox (fire_at) WHERE status = 'pending';
