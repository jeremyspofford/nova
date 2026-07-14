-- Migration 011: rolling conversation summary for compaction.
-- summary_upto = created_at of the newest message the summary covers.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary_upto TIMESTAMPTZ;
