-- Migration 130: what a coding session cost, written on the session's own row.
--
-- ROADMAP #47 rail 3 said "tokens: countable only when the coding agent
-- reports usage" — and the agent HAS been reporting it all along. Measured
-- 2026-08-08 against the live broker: every session's ACP update stream ends
-- in `usage_update` frames carrying a cumulative `cost` in USD (last night's
-- three finished sessions: $3.17, $2.53, $7.51), and the protocol's final
-- response carries an inputTokens/outputTokens block. Nothing aggregated any
-- of it, so every spend_ledger row is metered=false and the 2M-token/$10
-- daily ceilings in migration 116 enforce nothing — the pass count is the
-- only limit that binds.
--
-- The broker now aggregates those frames into its snapshot and coder.refresh
-- writes them here, on the durable row, because the broker holds sessions in
-- memory and a restart erases the only copy of what a pass cost.
--
-- ALL FOUR COLUMNS ARE NULLABLE AND NULL MEANS UNMEASURED, never free. A
-- sidecar built before the aggregation reports nothing, and a session the
-- broker forgot has nothing to report — writing 0 for either would read as
-- cheap, which is the fallback-that-looks-like-success this repo keeps
-- deleting. `model` is the pin the broker's own process was launched with
-- (ANTHROPIC_MODEL), recorded per session because the operator can change the
-- pin between sessions and a ledger that answers "which model wrote this"
-- with today's .env is guessing.

ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS tokens_in bigint;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS tokens_out bigint;
ALTER TABLE coding_sessions ADD COLUMN IF NOT EXISTS usd numeric(12,4);
