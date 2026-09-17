-- S22: a suite run can be STOPPED, and it can stop itself.
--
-- On 2026-09-12 a video game held this machine's GPU. A suite run scored
-- zero of twenty-three cases: every one of them ungradeable, each costing
-- 300 s of silence at the gateway's read limit. Two hours to produce a
-- result that was knowable after the third case. The only way to stop it
-- was restarting core, which I did twice — and a restart closes the row
-- 'interrupted' through the orphan sweep, so the record could not even say
-- that a person had stopped it on purpose.
--
-- Two columns and one status:
--
--   cancel_requested_at — set by POST /api/v1/evals/runs/{id}/cancel. The
--   job notices at its next CASE BOUNDARY, never mid-case: a case that is
--   already running has a scratch person and possibly fixture agents to
--   tear down, and killing it between those would leak exactly the rows
--   _sweep_orphan_scratch_people exists to clean up.
--
--   'cancelled' as its own terminal status, rather than reusing
--   'interrupted'. They are different facts about the record: interrupted
--   means the process died under it, cancelled means a person said stop.
--   A reader looking at a half-finished run should not have to guess which.
--
-- The existing constraints still hold as written: a terminal row has an
-- ended_at, and only 'error' is required to state a reason (a cancelled run
-- states one anyway — close_suite_run always writes it).

ALTER TABLE eval_suite_runs
    DROP CONSTRAINT IF EXISTS eval_suite_runs_status_check;

ALTER TABLE eval_suite_runs
    ADD CONSTRAINT eval_suite_runs_status_check
    CHECK (status IN ('running', 'done', 'error', 'interrupted', 'cancelled'));

ALTER TABLE eval_suite_runs
    ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
