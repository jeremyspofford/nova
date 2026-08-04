-- How many of a run's tasks the model was actually ASKED.
--
-- `tasks_total` is the suite's size and `tasks_passed` is what the model got
-- right, and between those two there was no room to say "it never saw the
-- question". A task whose call is refused before it reaches the model — a
-- prompt over the VRAM-sized window, an unservable tool — still counted in
-- the denominator, so the score read as a verdict on the model when it was a
-- fact about the machine.
--
-- Measured 2026-08-04, one tournament night over the `main` suite:
--
--   model         recorded   asked   what it means
--   gemma4:12b    0/7        0       no data at all
--   gemma4:e2b    0/7        2       0 of 2
--   qwen3:14b     2/7        6       2 of 6
--   qwen3:8b      1/7        7       the only complete run
--
-- The ranking built on that crowned qwen3:14b and put gemma4:12b and
-- ornith:9b last at 0% — on zero questions asked. Two models were scored for
-- failing tasks nobody put to them.
--
-- Existing rows get NULL, which is honestly "unknown" rather than a guess:
-- they were recorded before anyone counted, and back-filling them from
-- detail->tasks would invent a number for runs whose detail predates the
-- gradeable flag entirely.
ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS tasks_gradeable INTEGER;

COMMENT ON COLUMN eval_runs.tasks_gradeable IS
  'Tasks the model was actually asked — reached it and produced an answer to '
  'grade. NULL = recorded before this was counted. A run is comparable with '
  'another only when this equals tasks_total: a model asked six of seven '
  'questions did not sit the same test.';
