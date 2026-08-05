-- When a tournament night was last CLAIMED, and what came of it.
--
-- Exactly the defect migration 089 was written for, in the one job that did
-- not adopt the fix. `model_tournament._last_run` was a module global holding
-- `time.monotonic()`, so the "once every N hours" gate measured UPTIME, not
-- time: a fresh process starts at 0.0, `monotonic()` on Linux is
-- seconds-since-boot, and `monotonic() - 0.0 < 86400` is therefore False on
-- any box that has been up for a day. Every restart re-armed the interval and
-- the very first scheduler tick launched another night.
--
-- MEASURED 2026-08-05, before this landed: 210 backend starts in 48h, 177
-- tournament launches, ZERO finishes. 173 eval_runs rows in status='error',
-- 166 of them stamped 'the run stopped reporting and was declared dead' by
-- the orphan reaper, and not one passing run in the table's history. Because
-- `next_pairing` counts an errored run as an ATTEMPT (deliberately, so an
-- ungradeable suite cannot park the rotation forever), each abandoned run
-- marked its suite freshly covered, so the rotation walked all eight suites
-- in about twenty minutes recording nothing at all.
--
-- The second half of the damage was worse and had nothing to do with evals:
-- `maybe_run()` was AWAITED inline inside `scheduler.tick()`, and a night is
-- six models with a 3600s ceiling each. The tick never reached its second
-- iteration, so everything below that line — `automations.due()` and the
-- entire automation body — never ran for the life of the process. Her
-- followed sources went unpolled, stale knowledge unrefreshed, the digest
-- unsent. Nothing surfaced it, because the heartbeat that would have raised
-- an alert about a dead heartbeat was itself below the block.
--
-- WHY AN ATTEMPT TABLE AND NOT max(started_at) FROM eval_runs. eval_runs has
-- no origin column, so an operator clicking Run in the evals UI is
-- indistinguishable from a tournament-launched run. Gating on it would let a
-- manual eval silently cancel that night's tournament, and a burst of them
-- cancel it indefinitely — trading a loud bug for a quiet one.
--
-- The row is written BEFORE the work, preserving the intent the module global
-- had right: a night that dies half way must not re-enter on the next tick
-- and spend another six hours of the box.
CREATE TABLE IF NOT EXISTS tournament_attempts (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at      timestamptz NOT NULL DEFAULT now(),
  outcome text        NOT NULL,   -- 'claimed' | 'ok' | 'nothing_due' | 'error'
  suite   text,                   -- the suite this night was spent on
  detail  text                    -- ran/skipped counts, or the error text
);

CREATE INDEX IF NOT EXISTS tournament_attempts_at_idx
  ON tournament_attempts (at DESC);

COMMENT ON TABLE tournament_attempts IS
  'One row per tournament night claimed by the scheduler. Read to decide '
  'whether a night is due (max(at) vs evals.tournament_every_hours, which '
  'survives a restart where a module global did not). Written before the '
  'work, so a night that dies half way does not re-enter on the next tick.';
