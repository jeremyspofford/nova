-- 2026-08-07→08: ~6.3M prompt tokens went to OpenRouter overnight through
-- chat, evals, automations and the heartbeat, and no surface could add them
-- up — the counts sit in llm_call spans' detail, but the only llm_call index
-- is by trace_id, so a by-day rollup walks every span ever written (6k today,
-- unbounded tomorrow). Same shape as turn_spans_tool_recent_idx: the rollup
-- (GET /api/v1/spend/tokens) reads the last N days of ONE kind, newest first.
CREATE INDEX IF NOT EXISTS turn_spans_llm_recent_idx
    ON turn_spans (started_at DESC) WHERE kind = 'llm_call';
