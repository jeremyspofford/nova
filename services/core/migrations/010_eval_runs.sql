-- The eval ledger: one row per case scored against one model, on one run of a
-- suite. Written by the evals runner (app/evals/runner.py) and read by NO
-- decision path — the AI Quality page (T3) and the DoD walk read it for
-- reporting only, exactly like governance_events. The score MEASURES a model; it
-- never gates a turn, a tool, or a promotion. (fitness measures, never declares.)
--
-- suite_version is stored on every row so a score is only ever compared across
-- runs of the SAME version: change a suite's cases, bump its version, and old
-- rows fall out of the new denominator instead of silently blending in.
--
-- turn_id points at the eval turn's trace (turns/turn_spans, written with
-- kind='eval' so it is attributable but filtered out of the Activity feed). ON
-- DELETE SET NULL: the eval ledger outlives the trace it links, so pruning a
-- turn never erases the fact that the run happened.

CREATE TABLE eval_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    suite         text NOT NULL,
    suite_version int  NOT NULL,
    model         text NOT NULL,
    case_id       text NOT NULL,
    -- passed is NULL exactly when the run is UNGRADEABLE (the turn errored:
    -- gateway down, model not installed, empty reply). The CHECK makes that
    -- pairing a database invariant, so an errored turn can NEVER be stored as a
    -- fabricated 0/false and later counted against a model (the v3 tournament
    -- lesson: an ungradeable run is excluded from the denominator, not scored 0).
    passed        boolean,
    ungradeable   boolean NOT NULL DEFAULT false,
    detail        jsonb   NOT NULL DEFAULT '{}',
    turn_id       uuid REFERENCES turns (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT eval_runs_gradeable_pairs_passed CHECK (
        (ungradeable AND passed IS NULL) OR (NOT ungradeable AND passed IS NOT NULL)
    )
);

-- The page and the walk read by (suite, suite_version, model), newest first.
CREATE INDEX eval_runs_suite_version_model
    ON eval_runs (suite, suite_version, model, created_at DESC);
