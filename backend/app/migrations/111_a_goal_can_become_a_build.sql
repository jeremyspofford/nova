-- Migration 111: a goal can become a build.
--
-- ROADMAP #34 phase I3. This session built both ends and left them apart: she
-- can PROPOSE work (the ideator, 109) and she can BUILD work (write → sandbox
-- → review → land, df1c502), and nothing joined them. An approved idea became
-- a goal that sat in a list, and a build was a task somebody typed out again
-- by hand.
--
-- The join is one column. A coding session records which goal it was for, so
-- "what came of that idea?" is answerable from the row rather than from
-- somebody's memory of which branch was which.
--
-- ON DELETE SET NULL, not CASCADE. Deleting a goal must never delete the
-- record of work done under it — the work happened, and a goal removed from
-- the list is the operator tidying his list, not a statement that the branch
-- never existed.
--
-- THE LINK AUTHORISES NOTHING, which is the thing to keep true as this grows.
-- `goal_id` on a build is a LABEL. The build is still approved on its own
-- card, the landing is still a second card, and a goal carrying verbs (a
-- standing pre-approval) has no bearing on either — `goals.spend` matches on
-- the verb, and neither `code_change.build` nor `code_change.land` is a verb
-- any goal can pre-approve. Three gates stay three gates: approve the idea,
-- approve the build, approve the landing.
--
-- The spec (docs/plans/ideation-goals.md, phase I3) waits on the coding
-- pipeline's `coding_tasks` table for this. It does not need to:
-- `coding_sessions` already exists, already holds the task, the branch, the
-- commit, the patch, the sandbox verdict and the review verdict, and a second
-- table whose only new content is a `goal_id` would be a table to keep in
-- sync rather than a feature.

ALTER TABLE coding_sessions
    ADD COLUMN IF NOT EXISTS goal_id uuid
        REFERENCES goals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS coding_sessions_goal_idx
    ON coding_sessions (goal_id) WHERE goal_id IS NOT NULL;

COMMENT ON COLUMN coding_sessions.goal_id IS
    'The goal this work was for. A LABEL, never an authorisation: the build '
    'and the landing are each approved on their own card regardless of what '
    'the goal pre-approves.';
