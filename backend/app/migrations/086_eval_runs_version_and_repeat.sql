-- A recorded eval score was missing the two things that decide whether it
-- still means anything: WHICH suite produced it, and HOW MANY draws it is.
--
-- Both were found by acting on the data. model_fitness now blocks a model on
-- a recorded zero, and the zero it found for ornith:9b was from 2026-07-28 —
-- graded against a suite where ten of main's tools could not be served in
-- replay, so every model scored worse than it was. Nothing on the row said
-- so. `suite_version` is already declared in every suite.json and carried on
-- the Suite object; it simply was never written down.
--
-- repeat_count is the other half. Two runs of the same seven tasks, hours
-- apart, scored 2/7 and 3/7 — and the task that flipped was one nothing had
-- touched. A single run is a draw, and `assess()` was reporting it as a
-- measurement. Recording the sample size lets the finding say which it is.
--
-- Existing rows get repeat_count = 1, which is exactly what they were, and
-- suite_version NULL, which is honestly "unknown" rather than a guess.

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS suite_version INTEGER,
  ADD COLUMN IF NOT EXISTS repeat_count  INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN eval_runs.suite_version IS
  'suite.json suite_version at the time of the run. NULL = recorded before '
  'this column existed, so the suite it graded is unknown.';

COMMENT ON COLUMN eval_runs.repeat_count IS
  'How many times each task ran. A task counts as passed only if it passed '
  'every repeat.';
