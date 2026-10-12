-- S46a (machine setup, wake): the wake ledger (spec §4.3; hub-topology §2.1
-- "Wake ledger": core wake_attempts, one writer, app/wake_attempts.py).
-- The next free number after 044_no_round_ceiling; if a lane that lands a
-- later number (slice/s32-2's 046_code_repos) deploys first, this renumbers
-- above it before merge (plan_pending refuses an unrecorded lower number).
--
-- One row per attempt to wake a machine. A row is opened when the relay
-- reports SENT (or, nothing sent, decided at once as relay_cannot /
-- not_asleep with the words), gains answered_at (the machine's agent
-- reconnected) and serving_at (its model answered) as evidence arrives
-- inside the deadline, and is decided once. The CHECKs below are the line of
-- code that refuses an outcome the row's own columns do not show: no writer
-- can store `ready` for a machine whose model never answered.
--
-- The MAC is stored plain: devices.facts already holds it plain (net.ifaces),
-- so a hash would hide nothing the database does not hold, and the row must
-- stay evidence of the exact address the packet carried after facts change.
-- The database is private, the repo is public: wake_attempts.py's reads
-- leave it out, so reply and span text never carry it.
--
-- Every outcome the spec names is in the CHECK now (S46a.2 adds route
-- wakes, S46a.4 tests/stopped/interrupted) so no later cut needs an ALTER.
-- Re-runnable: its test executes it a second time.
CREATE TABLE IF NOT EXISTS wake_attempts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- the machine being woken; its attempts go with it
    device_id       uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    -- the agent that sent the packet; NULL when none could (relay_cannot) or
    -- once that agent's device row is gone
    relay_device_id uuid REFERENCES devices (id) ON DELETE SET NULL,
    -- what was sent where: the target's adapter (an interface name from its
    -- facts) and MAC, the relay's interface, the directed broadcast, the count
    adapter         text,
    mac             macaddr,
    relay_iface     text,
    broadcast       inet,
    packets         integer CHECK (packets >= 1),
    trigger         text NOT NULL CHECK (trigger IN ('tool', 'route', 'test')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    deadline_s      integer NOT NULL DEFAULT 120 CHECK (deadline_s BETWEEN 30 AND 600),
    answered_at     timestamptz,
    serving_at      timestamptz,
    -- NULL while open
    outcome         text CHECK (outcome IN (
        'ready', 'answered', 'no_answer', 'relay_cannot', 'not_asleep', 'stopped', 'interrupted'
    )),
    decided_at      timestamptz,
    reason          text,
    turn_id         uuid REFERENCES turns (id) ON DELETE SET NULL,
    -- the wake test series this attempt belongs to; its FK comes with the
    -- wake_tests table (S46a.4)
    test_id         uuid,

    CONSTRAINT wake_attempts_decided_together
        CHECK ((outcome IS NULL) = (decided_at IS NULL)),
    -- a sent row says what was sent where
    CONSTRAINT wake_attempts_sent_says_what
        CHECK (sent_at IS NULL OR (
            mac IS NOT NULL AND adapter IS NOT NULL AND relay_iface IS NOT NULL
            AND broadcast IS NOT NULL AND packets IS NOT NULL
        )),
    -- nothing sent: decided at once as relay_cannot / not_asleep, with the
    -- words, and no evidence of an answer to a packet that never left
    CONSTRAINT wake_attempts_unsent_says_why
        CHECK (sent_at IS NOT NULL OR (
            COALESCE(outcome IN ('relay_cannot', 'not_asleep'), false)
            AND COALESCE(reason <> '', false)
            AND answered_at IS NULL AND serving_at IS NULL
        )),
    CONSTRAINT wake_attempts_unsent_outcomes
        CHECK (outcome NOT IN ('relay_cannot', 'not_asleep') OR sent_at IS NULL),
    -- evidence counts only after the send and inside the deadline
    CONSTRAINT wake_attempts_answered_in_window
        CHECK (answered_at IS NULL OR (
            answered_at >= sent_at
            AND answered_at <= sent_at + deadline_s * interval '1 second'
        )),
    CONSTRAINT wake_attempts_serving_in_window
        CHECK (serving_at IS NULL OR (
            serving_at >= sent_at
            AND serving_at <= sent_at + deadline_s * interval '1 second'
        )),
    -- the outcome is what the evidence shows
    CONSTRAINT wake_attempts_ready_served
        CHECK (outcome <> 'ready' OR serving_at IS NOT NULL),
    CONSTRAINT wake_attempts_answered_not_served
        CHECK (outcome <> 'answered' OR (answered_at IS NOT NULL AND serving_at IS NULL)),
    CONSTRAINT wake_attempts_no_answer_silent
        CHECK (outcome <> 'no_answer' OR (answered_at IS NULL AND serving_at IS NULL))
);

-- One open attempt per machine: the database's own answer, so a background
-- wake (S46a.2) and her tool can never both send while one is in flight.
CREATE UNIQUE INDEX IF NOT EXISTS wake_attempts_one_open
    ON wake_attempts (device_id) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS wake_attempts_recent
    ON wake_attempts (device_id, created_at DESC);
