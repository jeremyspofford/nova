-- Migration 128: one finished eval is ONE announcement, under a race.
--
-- THE FAILURE. Migration 127 shipped with this claim, in the code comment
-- above `eval_runs._announce` and in the migration itself: the same run
-- announced twice (its own path and the backlog sweep racing) "folds onto
-- one notification instead of buzzing twice". It does not. `notify.send`
-- dedupes by SELECTing notifications.find_repeat and then INSERTing, and
-- notifications_fingerprint_idx is a plain btree — so two callers that read
-- before either writes both see no repeat and both publish. Measured in the
-- backend container against one unannounced terminal run:
--
--     three concurrent eval_runs._announce(rid):
--         3 pushes delivered, 3 notifications rows, 3 role='notification'
--         chat pointers, all three returning deduped=False
--     the same three run one after another:
--         1 push, the other two deduped=True
--
-- Read-then-insert folds SERIALIZED retries, which is the case it was
-- actually written for, and nothing else. And the race is not theoretical:
-- `_execute` writes its verdict, then awaits `progress()` and `notify.send()`
-- before `announced_at` is ever set, while `_sweep`'s `_announce_backlog`
-- runs on the same event loop every 60s and its query — announced_at IS NULL
-- AND status <> 'running' — matches exactly that window. Two backends (a
-- test run, `python -m app.evals`, a second container) widen it further:
-- an in-process lock could not close that half at all.
--
-- `_record_announcement`'s `WHERE announced_at IS NULL` makes the ROW
-- exactly-once. It runs after the send, deliberately — claiming first
-- produces a row saying the operator was told by a process that died before
-- telling him — so it can never make the NOTIFICATION exactly-once.
--
-- THE COLUMNS BELOW ARE THE LINE THAT REFUSES. The announce step is now
-- CLAIMED before the send, on the same shape `_claim_stale` already uses for
-- the run itself: an UPDATE ... WHERE (nobody holds it, or the lease has
-- expired) RETURNING id. Under READ COMMITTED the second writer re-evaluates
-- that WHERE against the winner's committed row, so exactly one caller gets
-- a row back and the losers return without sending. The claim is a LEASE and
-- not a flag, because a process that dies between claiming and sending must
-- not silence the announcement forever — that is the same trade the run
-- claim makes, for the same reason, and the backlog sweep is what picks it
-- up once the lease lapses.

ALTER TABLE eval_runs
    -- When someone took the announce step for this run. NOT "when it was
    -- announced" — `announced_at` is that, and it is written after the send.
    -- A claim older than eval_runs.ANNOUNCE_LEASE_S is dead and re-takeable.
    ADD COLUMN IF NOT EXISTS announce_claimed_at TIMESTAMPTZ,
    -- Which instance holds it, so a stuck announcement names a process
    -- rather than being anonymous.
    ADD COLUMN IF NOT EXISTS announce_claimed_by TEXT;

COMMENT ON COLUMN eval_runs.announce_claimed_at IS
    'Lease on the announce step, taken BEFORE notify.send so two callers '
    'racing cannot both publish (notify.send dedupe is read-then-insert and '
    'only folds serialized retries). Expiry is eval_runs.ANNOUNCE_LEASE_S; '
    'an expired claim on a row with announced_at NULL is retried by the '
    'backlog sweep.';
COMMENT ON COLUMN eval_runs.announce_claimed_by IS
    'The instance id that holds/held the announce lease. Evidence, not a '
    'gate — the claim UPDATE is the gate.';

-- The backlog sweep reads (announced_at IS NULL AND status <> 'running')
-- and now also skips rows under a live lease, so a run being announced right
-- now by another process does not eat one of the five slots per pass. Same
-- partial index as 127 covers it; the lease test is a filter on top.
CREATE INDEX IF NOT EXISTS eval_runs_announce_claim
    ON eval_runs (announce_claimed_at)
    WHERE announced_at IS NULL AND status <> 'running';

-- No grants, no tool changes, no prompt changes: this closes a hole in a
-- path that already exists, so the pinned snapshots (granted.json,
-- test_eval_grants, test_eval_servability, the reads_only count) stay
-- untouched — there is nothing for them to notice.
