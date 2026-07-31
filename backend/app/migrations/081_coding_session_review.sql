-- The review surface becomes durable. #20 phase 3.
--
-- `denials` and `commands` are what the broker's adjudicator refused and
-- approved during a session. They were living only in the broker's memory,
-- which contradicts the principle `app/coder.py` already states: the broker is
-- ephemeral and loses sessions on restart, and `coding_sessions` is the
-- durable record. A review surface that disappears when the sidecar restarts
-- is not a review surface — the operator reviews AFTER the run, which is
-- exactly when the in-memory copy is most likely to be gone.
--
-- `commands` matters more than it looks. "Did it actually run the tests?" is
-- the first question a reviewer asks, and the answer must not be the agent's
-- own account of itself — this codebase already learned that a `commands_run`
-- field filled in by the model is a claim, not evidence. These rows are
-- written where the adjudicator approved the call.
--
-- JSONB rather than two more tables: they are a per-session audit blob that is
-- read whole and never queried across sessions.

ALTER TABLE coding_sessions
    ADD COLUMN IF NOT EXISTS denials  jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS commands jsonb NOT NULL DEFAULT '[]'::jsonb;
