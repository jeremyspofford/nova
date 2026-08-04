-- Recommendation actions, phase 2: approving a card executes its plan.
--
-- ONE CLICK (Jeremy, 2026-08-04): Approve registers, connects, grants and
-- verifies in a single run. There is deliberately no 'awaiting_grant' pause
-- — the operator authorised the grant when he approved a plan that named
-- `grant_to`, and a run that parks waiting for a second button is the
-- theatre this lane exists to remove.
--
-- What that costs is paid for by `action_tools` below rather than by a
-- second click.

CREATE TABLE IF NOT EXISTS action_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  -- FROZEN at approve time. The card's own `action` column can still be
  -- rewritten by create()'s ON CONFLICT branch; what the operator approved
  -- cannot.
  action            jsonb NOT NULL,
  action_type       text  NOT NULL,
  status            text  NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  steps             jsonb NOT NULL DEFAULT '[]',   -- append-only receipt log
  result            jsonb,
  error             text,
  attempts          int   NOT NULL DEFAULT 0,
  orphans           int   NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A double-click, a re-POST, or two tabs cannot start two runs for one card.
-- This index is the refusal, not a check in Python.
CREATE UNIQUE INDEX IF NOT EXISTS action_runs_one_live_per_rec
  ON action_runs (recommendation_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS action_runs_queued_idx
  ON action_runs (created_at) WHERE status = 'queued';

-- The tool list the PREFLIGHT fetched, as {name, description} — i.e. exactly
-- what the operator was shown on the card before he clicked.
--
-- This is what makes one click honest. mcp_servers.refresh() treats the
-- first tool list it ever sees as the approved baseline (`stored_hash IS
-- NULL`), so registering a server has always meant accepting a stranger's
-- tool DESCRIPTIONS unread — and those descriptions land in the granted
-- agent's prompt. With this column the descriptions are rendered on the card,
-- and the executor registers the server with tools_hash ALREADY SET to the
-- hash of what was shown. A server that changed its tools between the
-- preflight and the click therefore fails the existing hash check on first
-- connect and the run rolls back, instead of silently installing something
-- nobody read.
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS action_tools jsonb;
