-- Migration 097: a run can stop, ask one question, and carry on where it was.
--
-- Phase 3. Jeremy, 2026-08-05: "She needs to be able to go and do things on
-- her own, figure it out, without me needing to do it for her while she
-- explains to me like she's google what to do step by step." And, on where
-- the question goes: "Questions, if any, that need clarification from me for
-- nova, should be asked via chat."
--
-- Until now an approved card ran ONE executor call to completion or failure.
-- Everything real is longer than that — start a service, wait for it, check
-- the operator can actually reach it, report back — and any question in the
-- middle ended the turn and lost the position. He then re-explained from the
-- beginning, which is the failure he named.
--
-- Four columns and one status:
--
--   step_index      the resume cursor. Steps are named and ordered by the
--                   executor; this is how far it got. A backend restart
--                   mid-run resumes at the same step rather than replaying
--                   side effects from the top, which is why this is a cursor
--                   and not a "re-run and skip what's done" convention.
--   question        what it needs, as {key, text, asked_at}. Present only
--                   while status='blocked'.
--   answer          the operator's words, verbatim. Never parsed by SQL and
--                   never interpreted here; the step that asked reads it.
--   answered_at     so a blocked run that has been answered is claimable by
--                   exactly the same SKIP LOCKED query that claims a queued
--                   one — no second worker, no polling loop of its own.
--   conversation_id where the question was asked, so the answer can be found
--                   and the report lands in the same thread rather than a
--                   notification he has to go looking for.
--
-- 'blocked' joins the status check. It is deliberately NOT a terminal state
-- and deliberately NOT 'running': the one-live-per-recommendation index
-- covers queued+running so a blocked run must not hold that slot forever,
-- and a run waiting on a person is not a run this process is working on.

ALTER TABLE action_runs
    ADD COLUMN IF NOT EXISTS step_index      integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS question        jsonb,
    ADD COLUMN IF NOT EXISTS answer          text,
    ADD COLUMN IF NOT EXISTS answered_at     timestamptz,
    ADD COLUMN IF NOT EXISTS conversation_id uuid;

ALTER TABLE action_runs DROP CONSTRAINT IF EXISTS action_runs_status_check;
ALTER TABLE action_runs ADD CONSTRAINT action_runs_status_check
    CHECK (status = ANY (ARRAY['queued', 'running', 'blocked',
                               'succeeded', 'failed']));

-- Claimable work: queued, or blocked-and-answered. One partial index for the
-- second half so the worker's claim query stays a single indexed scan.
CREATE INDEX IF NOT EXISTS action_runs_answered_idx
    ON action_runs (answered_at)
    WHERE status = 'blocked' AND answer IS NOT NULL;

-- A blocked run still owns its recommendation — otherwise approving the same
-- card twice while the first is waiting on an answer starts a second run of
-- the same work. The original index covered queued+running only, because
-- before this migration those were the only non-terminal states.
DROP INDEX IF EXISTS action_runs_one_live_per_rec;
CREATE UNIQUE INDEX action_runs_one_live_per_rec
    ON action_runs (recommendation_id)
    WHERE status IN ('queued', 'running', 'blocked');
