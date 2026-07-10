-- 103_tool_execution_log.sql
-- Idempotency ledger for side-effecting agent tools.
--
-- Nova's crash-recovery paths deliberately re-run work: the reaper re-pushes
-- tasks stuck in 'queued' (reaper.py:_reap_stuck_queued_tasks) and the pipeline
-- checkpoint system re-enters a stage that crashed before save_checkpoint. Both
-- are safe for *pure* recomputation, but a stage that already fired an
-- irreversible, outward-facing tool call (open a PR, push a branch, send a
-- phone push) would perform that side effect a SECOND time on replay.
--
-- This table records each such call keyed by (task_id, tool, args). The
-- dispatch layer (app/tool_idempotency.py, wired into app/tools/__init__.py)
-- claims a row BEFORE executing; a replay finds the claim and returns the
-- cached result instead of re-executing. See app/tool_idempotency.py for the
-- claim/commit/rollback protocol and the exact set of wrapped tools.

CREATE TABLE IF NOT EXISTS tool_execution_log (
    idempotency_key TEXT PRIMARY KEY,        -- sha256(task_id : tool_name : canonical_args)
    task_id         UUID NOT NULL,
    tool_name       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'in_progress',  -- 'in_progress' (claimed) | 'done' (result cached)
    result          TEXT,                    -- the tool's result string, populated on commit
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

-- Fast lookup of a task's ledger (audit / debugging / cleanup by task).
CREATE INDEX IF NOT EXISTS idx_tool_execution_log_task ON tool_execution_log (task_id);
-- Diagnostics / manual cleanup of stale in-progress claims (a crash between
-- claim and commit leaves one). NOT auto-swept: an in_progress claim means a
-- side effect's fate is unknown, and blindly deleting it would reopen the
-- duplicate-execution window this table exists to close.
CREATE INDEX IF NOT EXISTS idx_tool_execution_log_inflight
    ON tool_execution_log (created_at) WHERE status = 'in_progress';
