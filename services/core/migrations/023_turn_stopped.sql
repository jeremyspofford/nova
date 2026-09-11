-- S15 — the owner's Stop needs a status of its own.
--
-- 'interrupted' already means something specific and different: NO process was
-- running the turn, which is what the startup sweep writes for an orphan of a
-- dead process, and what the scheduler reads to decide a firing did nothing
-- wrong. A deliberate Stop is the opposite fact — a process WAS running it and
-- was told to quit — so overloading 'interrupted' would leave the Activity
-- page unable to tell a redeploy from someone pressing a button, and would
-- quietly change what the scheduler's failure counting means.

ALTER TABLE turns DROP CONSTRAINT turns_status_check;

ALTER TABLE turns
    ADD CONSTRAINT turns_status_check
    CHECK (status IN ('ok', 'error', 'interrupted', 'stopped'));
