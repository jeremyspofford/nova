-- Migration 105: a retry resumes the last attempt instead of restarting.
--
-- Jeremy's flow, step 5: "loop 3 & 4 until completed the task". `_step_build`
-- has looped since ea9e70f and the loop had never run — and reading it before
-- running it found the reason it could not have worked.
--
-- EVERY ATTEMPT CLONED THE TRUNK. The broker services `/session` with a fresh
-- `git clone` of `git://git-landing/repo`, so attempt 2 opened a checkout in
-- which attempt 1's change did not exist — while its prompt said "a previous
-- attempt was rejected by the sandbox check, fix this before anything else"
-- and quoted a test failure the agent could not reproduce, because the code
-- that caused it was not there. That is worse than a plain retry: a plain
-- retry is a second roll of the dice, and this was a false premise.
--
-- Now the retry clones the PREVIOUS SESSION'S OWN DIRECTORY, so the broken
-- change is really in the tree and the agent can run the failing check itself
-- before editing anything. This column is what makes that legible afterwards:
-- "attempt 2 resumed attempt 1" is a recorded fact rather than something a
-- reader infers from two timestamps.
--
-- Self-referential and ON DELETE SET NULL: losing the parent row must not take
-- the child's record of its own work with it.

ALTER TABLE coding_sessions
    ADD COLUMN IF NOT EXISTS continued_from uuid
        REFERENCES coding_sessions(id) ON DELETE SET NULL;

COMMENT ON COLUMN coding_sessions.continued_from IS
    'The session this one resumed — its clone was the starting tree, so this '
    'session''s patch contains that attempt''s commits as well as its own. '
    'NULL means it started from the trunk.';
