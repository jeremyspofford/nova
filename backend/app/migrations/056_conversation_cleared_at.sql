-- /clear — a context watermark, not a delete.
--
-- Nova has exactly one conversation, forever (conversations.get_or_create_
-- active_conversation: "newest row wins"), and there was no way to start
-- over. That became a correctness problem rather than an ergonomic one on
-- 2026-07-27: the conversation held contradictory claims about what Nova
-- could do, and the same question answered "yes" and "no" 23 seconds apart
-- depending on which turns the window happened to carry.
--
-- The watermark, rather than deleting rows, because:
--   * the turn ledger and the activity trail reference these rows
--   * the journal keeps every exchange anyway, so a delete buys no privacy
--   * it is reversible — clearing by mistake costs nothing
--
-- summary_reset_at is separate on purpose. The rolling summary is merged
-- from aged-out turns, so clearing the window without clearing the summary
-- would leave the pre-clear conversation alive in a 300-word paraphrase —
-- the exact thing the operator asked to get away from.
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

COMMENT ON COLUMN conversations.cleared_at IS
    'Context watermark: load_history and compaction ignore messages at or '
    'before this. Rows are kept; only the working window resets.';
