-- S11 the proactive engine: she notices, she acts, she tells him once.
--
-- A BEAT is a fourth timer kind. It is a timer and not a new loop so that it
-- inherits, already tested, the FOR UPDATE SKIP LOCKED claim that makes a
-- firing exactly-once, the pause-after-5-consecutive-failures ceiling with
-- its reason on the row, the firings history with its per-channel delivery
-- receipt, retention, and "Run now" on the Schedules page. Two rows are
-- seeded: `watch` (hourly — it runs the checks and may act) and `digest`
-- (daily, at the hour the owner sets — it writes the one message).
--
-- A beat belongs to the owner like any person timer: its findings are his,
-- its spend is his, and the digest lands in his conversation.
ALTER TABLE timers DROP CONSTRAINT timers_kind_check;
ALTER TABLE timers ADD CONSTRAINT timers_kind_check
    CHECK (kind IN ('reminder', 'scheduled', 'job', 'beat'));

-- One piece of news, recorded BEFORE any delivery is attempted so that a
-- channel which is disabled, unconfigured or broken leaves an honest record
-- instead of silence; the delivery outcome is written back onto this row.
--
-- fingerprint is a hash of the DERIVED FACTS a check returned, never of the
-- sentence about them. v3 shipped the other way — sha256 over the model's own
-- text — and one model re-worded two findings into fourteen phone pushes in
-- eight hours (2026-08-08). A finding may only speak again when the world
-- changes, and the model does not get a vote in what "changed" means.
--
-- A repeat FOLDS onto the row it matches: repeats is incremented and nothing
-- is delivered. Suppression is countable, never silent — the firing's record
-- says which notice it folded onto and how many times.
--
-- state: raised (recorded, not yet delivered) -> delivered | failed, and
-- then seen (the owner actually opened it) or muted (stop telling me until
-- the facts change). NOTHING here is an authorization: muting is a noise
-- preference and seen is a read receipt (owner ruling 2026-09-03). The CHECKs
-- demand evidence for each state, because "accepted by transport" is not
-- "received" and a state nobody can prove is a state that lies.
CREATE TABLE notices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The beat turn that found it, and that turn's firing. Both survive the
    -- turn being swept, so a notice always says where it came from.
    turn_id        uuid REFERENCES turns (id) ON DELETE SET NULL,
    firing_id      uuid REFERENCES timer_firings (id) ON DELETE SET NULL,
    -- The registered check's name. Derived from the registry at write time,
    -- never free text the model chose.
    check_name     text NOT NULL,
    -- Stable per subject ("timer_failing:<uuid>"), author-written in the
    -- check, so two findings about the same thing share a key.
    finding_key    text NOT NULL,
    fingerprint    text NOT NULL,
    -- Code-composed, both of them: the title is the check's own sentence and
    -- the facts are its evidence. The digest's PROSE is the model's and lives
    -- on the digest turn, never here.
    title          text NOT NULL,
    facts          jsonb NOT NULL DEFAULT '{}',
    -- Declared by the CHECK, never by a reply. Only the stack family may set
    -- it (pinned by a test), which is why an urgent notice may push at any
    -- hour: the volume is bounded by that one-item list, not by a clock.
    urgent         boolean NOT NULL DEFAULT false,
    -- What she DID about it, if anything, and the turn that did it.
    acted          boolean NOT NULL DEFAULT false,
    acted_turn_id  uuid REFERENCES turns (id) ON DELETE SET NULL,
    acted_note     text,
    repeats        int NOT NULL DEFAULT 1 CHECK (repeats >= 1),
    state          text NOT NULL DEFAULT 'raised'
                   CHECK (state IN ('raised', 'delivered', 'failed', 'seen', 'muted')),
    -- Per-channel receipts, exactly as a firing records them: ok only from a
    -- channel's own result, failed with the stated reason, and "stated" for
    -- "no paired device was connected" — an absent rung is never a delivery.
    delivery       jsonb NOT NULL DEFAULT '{}',
    failed_reason  text,
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    -- When the condition STOPPED being true. A watch beat that ran a check
    -- and did not find a notice's fingerprint among its findings has watched
    -- that condition clear, and says so here. This is what lets a fixed thing
    -- that breaks again be NEWS rather than a fold onto a row from last week:
    -- without it, "one live row per fingerprint" means "tell him once, ever".
    -- Only a check that actually RAN may clear its own notices — a probe that
    -- could not be made has watched nothing (the all-clear-that-checked-
    -- nothing defect, in its quietest form).
    cleared_at     timestamptz,
    delivered_at   timestamptz,
    seen_at        timestamptz,
    muted_at       timestamptz,
    CONSTRAINT notices_delivered_says_when
        CHECK (state <> 'delivered' OR delivered_at IS NOT NULL),
    CONSTRAINT notices_failed_says_why
        CHECK (state <> 'failed' OR failed_reason IS NOT NULL),
    CONSTRAINT notices_seen_says_when
        CHECK (state <> 'seen' OR seen_at IS NOT NULL),
    CONSTRAINT notices_muted_says_when
        CHECK (state <> 'muted' OR muted_at IS NOT NULL),
    CONSTRAINT notices_acted_names_its_turn
        CHECK (acted = false OR acted_turn_id IS NOT NULL)
);

-- The fold: at most one LIVE row per fingerprint. Partial on cleared_at so a
-- condition that cleared frees its fingerprint and can be news again if it
-- comes back; while it is still true, every sighting folds onto the one row.
--
-- A MUTED row is never cleared and so holds its fingerprint indefinitely.
-- That is the point of a mute: stop telling me about THIS until the facts
-- change, and identical facts are the same fingerprint whether or not the
-- condition blinked off and on in between.
CREATE UNIQUE INDEX notices_one_live_row_per_fingerprint
    ON notices (fingerprint) WHERE cleared_at IS NULL;

-- The digest's query: everything still true that he has not been told about,
-- INCLUDING a notice whose delivery failed — a repeat of something that never
-- landed is not a repeat, so 'failed' is deliverable, not finished.
CREATE INDEX notices_deliverable ON notices (first_seen_at)
    WHERE cleared_at IS NULL AND state IN ('raised', 'failed');
CREATE INDEX notices_recent ON notices (last_seen_at DESC);
