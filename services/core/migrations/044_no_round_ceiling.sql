-- 044: no tool-round ceiling (owner 2026-10-08). No count of tool rounds
-- stops a turn any more; a turn going in circles is still stopped by
-- chat.RoundProgress, which is not a count. The agents.max_tool_rounds
-- setting has no reader, and an orphan row would be invisible to the
-- registry (settings_store reads defs only), so it goes — the convention
-- 017 set for autonomy.graduation_runs. Forward-only; DELETE is idempotent.

DELETE FROM settings WHERE key = 'agents.max_tool_rounds';

-- Per-agent rounds go too (no-ceiling T6): no turn reads an agent's
-- max_tool_rounds since the count was removed, so the column is dropped.
-- Its column-level CHECK (021, BETWEEN 1 AND 50) goes with it. IF EXISTS
-- keeps a re-run a no-op.
ALTER TABLE agents DROP COLUMN IF EXISTS max_tool_rounds;
