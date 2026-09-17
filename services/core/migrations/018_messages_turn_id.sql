-- S10-pre: an assistant message remembers the turn that produced it, so a
-- transcript can be badged from the TRACE — the llm_call span's served_by,
-- the gateway's own X-Nova-Served-By — rather than from a stored claim.
-- Nullable: user messages have no turn, and rows from before this migration
-- carry none (their badge is simply absent, never invented).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_id uuid REFERENCES turns (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_turn ON messages (turn_id) WHERE turn_id IS NOT NULL;
