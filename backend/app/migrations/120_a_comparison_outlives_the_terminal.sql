-- A champion-vs-challenger verdict becomes a durable row.
--
-- `python -m app.evals run <suite> --champion X --challenger Y` runs both
-- models against identical frozen inputs, grades each against the suite's
-- mechanical contract, prints a scoreboard — and persists NOTHING. The
-- verdict lives in a terminal and dies there, so no downstream card, panel
-- or promotion decision can ever be raised from it. That is the exact defect
-- eval_runs (migration 060) fixed for single-model runs, unfixed for the one
-- comparison that actually informs a swap.
--
-- The key is (suite, suite_version, repeat_count, champion, challenger),
-- carried as columns and indexed, because those five things decide whether
-- two comparisons are the same measurement: a score against suite v8 does
-- not describe v12, and one repeat is a draw, not a measurement (ornith:9b
-- scored 2/7 then 3/7 on consecutive runs of the same suite). History is
-- kept — one row per run, never upserted — because a score that moves
-- between runs is the most informative thing the table can show.
--
-- DELIBERATELY NOT HERE: promotion. No winner column, no acted_on flag.
-- Scores flip run to run, and promoting on one night's numbers would promote
-- whichever model ran on a lucky night. This table makes the verdict durable
-- and readable; acting on it is a separate, deliberate decision.

CREATE TABLE IF NOT EXISTS eval_comparisons (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    suite             TEXT NOT NULL,
    suite_version     INTEGER NOT NULL,
    repeat_count      INTEGER NOT NULL DEFAULT 1,
    champion          TEXT NOT NULL,
    challenger        TEXT NOT NULL,
    -- the denominators, separately, so a partial night cannot read as a
    -- verdict: tasks_gradeable counts tasks BOTH sides actually answered in
    -- every repeat, and only those carry the pass counts below.
    tasks_total       INTEGER NOT NULL,
    tasks_gradeable   INTEGER NOT NULL,
    -- suite gaps (missing fixture, refused tool) — a fact about the suite,
    -- never folded into either model's score
    tasks_invalid     INTEGER NOT NULL DEFAULT 0,
    champion_passed   INTEGER NOT NULL,
    challenger_passed INTEGER NOT NULL,
    -- task ids the challenger failed where the champion passed (and the
    -- reverse) — the two lists a promotion decision actually reads
    regressions       JSONB NOT NULL DEFAULT '[]'::jsonb,
    improvements      JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- per-task breakdown: runs passed per side per repeat
    detail            JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- "the recorded verdicts for this pairing, newest first" is the reader's query
CREATE INDEX IF NOT EXISTS eval_comparisons_key
    ON eval_comparisons (suite, suite_version, champion, challenger, at DESC);

CREATE INDEX IF NOT EXISTS eval_comparisons_at
    ON eval_comparisons (at DESC);

COMMENT ON TABLE eval_comparisons IS
  'One row per champion-vs-challenger CLI run (python -m app.evals run). '
  'A verdict is durable and readable here; promotion is deliberately NOT '
  'derived from it — scores flip run to run.';
