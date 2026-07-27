-- Eval runs: does this model pass this agent's own tasks?
--
-- The harness (app/evals) already runs an agent's real tasks against a
-- candidate model in an isolated scratch store and grades the result against
-- a mechanical contract. It was CLI-only, so a verdict lived in a terminal
-- and died there. This is where a verdict persists, so the model picker can
-- show "qwen3:14b, 4/5 on ingestion, tested yesterday" without running
-- anything.
--
-- Also the source of the COST ESTIMATE. What a suite costs is measured from
-- what it has cost before, not guessed: a run records its own tokens and
-- duration, and the next operator to press the button is told the median of
-- previous runs rather than a number somebody made up.

CREATE TABLE IF NOT EXISTS eval_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suite         TEXT NOT NULL,
    agent_name    TEXT NOT NULL,
    model         TEXT NOT NULL,
    -- running | passed | failed | error. `error` is the HARNESS failing,
    -- which is not the model's fault and must never be read as a verdict.
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    tasks_total   INTEGER NOT NULL DEFAULT 0,
    tasks_passed  INTEGER NOT NULL DEFAULT 0,
    tokens_in     BIGINT NOT NULL DEFAULT 0,
    tokens_out    BIGINT NOT NULL DEFAULT 0,
    duration_s    DOUBLE PRECISION,
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    error         TEXT
);

-- "the latest verdict for this agent on this model" is the dropdown's query
CREATE INDEX IF NOT EXISTS eval_runs_lookup
    ON eval_runs (agent_name, model, started_at DESC);

-- "what has this suite cost before" is the estimate's query
CREATE INDEX IF NOT EXISTS eval_runs_suite
    ON eval_runs (suite, status, started_at DESC);
