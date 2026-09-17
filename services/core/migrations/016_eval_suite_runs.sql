-- A suite run is a server-side JOB whose truth lives here — detached from any
-- HTTP connection. Before this table, POST /evals/run ran every case INSIDE a
-- streaming response body: a page reload or a backgrounded PWA closed the
-- socket, starlette cancelled the generator mid-LLM-call, the remaining cases
-- never started, nothing recorded that a run had been cut off, and a second
-- click started a second run interleaved on the same GPU (two suites on one
-- model at once is contention, not a measurement). Now the API INSERTs this row,
-- spawns the job, and answers 202; the page is a VIEWER of the row.
--
-- status is the fact the page reads — 'running' while the job holds it, then
-- exactly one of 'done' (every case scored and persisted), 'error' (the job
-- itself failed — `error` says why), or 'interrupted' (the process running it
-- exited first: core's startup sweep closes every leftover 'running' row as
-- 'interrupted', because a fresh process runs no jobs by construction). A
-- partial run is never dressed as a score: the API computes a summary ONLY
-- over a 'done' run.
--
-- eval_runs.run_id links each scored case to its run. Nullable so the rows
-- persisted before this migration stand as they are (they belong to no run and
-- are never shown as "latest results" — a partial legacy run cannot be told
-- from a complete one, so none is promoted). ON DELETE SET NULL: the case
-- ledger outlives the run record.

CREATE TABLE eval_suite_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    suite         text NOT NULL,
    suite_version int  NOT NULL,
    model         text NOT NULL,
    status        text NOT NULL
                  CHECK (status IN ('running', 'done', 'error', 'interrupted')),
    case_count    int  NOT NULL,
    error         text,
    started_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    -- A row is 'running' exactly while it has no ended_at: a run cannot claim
    -- to have finished without saying when, and cannot carry an end time while
    -- still claiming to run.
    CONSTRAINT eval_suite_runs_terminal_has_ended_at CHECK (
        (status = 'running') = (ended_at IS NULL)
    ),
    -- A run that failed must say why. Never a silent 'error'.
    CONSTRAINT eval_suite_runs_error_states_why CHECK (
        status <> 'error' OR error IS NOT NULL
    )
);

-- ONE run at a time, as a database invariant — global, not per model: the GPU
-- is shared, so measuring one model while another suite runs is invalid
-- regardless of which model each names. A second INSERT while a row is
-- 'running' is refused by postgres itself (unique violation), never by a check
-- the API might forget. The index is over the constant `true` so every running
-- row collides with every other.
CREATE UNIQUE INDEX eval_suite_runs_one_running
    ON eval_suite_runs ((true)) WHERE status = 'running';

-- The page reads "the latest COMPLETE run for (suite, version, model)".
CREATE INDEX eval_suite_runs_suite_version_model
    ON eval_suite_runs (suite, suite_version, model, started_at DESC);

ALTER TABLE eval_runs
    ADD COLUMN run_id uuid REFERENCES eval_suite_runs (id) ON DELETE SET NULL;

CREATE INDEX eval_runs_run_id ON eval_runs (run_id);
