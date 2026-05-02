-- Tracks the last workflow_run id seen by polling per watched repo.
-- Prevents duplicate stimuli when the poller runs against the same repo repeatedly.

CREATE TABLE IF NOT EXISTS cortex_poll_state (
    watched_repo_id UUID PRIMARY KEY REFERENCES cortex_watched_repos(id) ON DELETE CASCADE,
    last_run_id     BIGINT NOT NULL DEFAULT 0,
    last_polled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
