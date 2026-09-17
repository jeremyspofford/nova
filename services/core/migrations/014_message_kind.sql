-- Approval choreography is PLUMBING, not conversation.
--
-- The owner's walk (2026-09-02 22:22): on a local model, "try again" produced a
-- reply whose whole stance was "still awaiting your approval" with no tool call.
-- Part of the cause is what the model was READING. Every approve the web
-- resumes posts a real user message ("You're approved: <summary>. Please go
-- ahead now.") and a card-pending turn persists "[waiting for your approval
-- before continuing]" — so a few approvals in, the history window handed to the
-- model is mostly approval choreography, and a small model pattern-completes
-- "awaiting approval" out of it instead of calling the tool.
--
-- Those rows are how the SYSTEM resumes a turn, not things the household said
-- to each other. They stay in the transcript the operator sees (nothing is
-- hidden), but they are marked here so the next turn's history window can leave
-- them out — the mechanical half of the fix, not a sentence asking the model to
-- ignore them.
--
-- 'chat' is the default, so every existing row and every ordinary message keeps
-- exactly the behaviour it had; only a writer that explicitly says 'plumbing'
-- opts a row out.
ALTER TABLE messages
    ADD COLUMN kind text NOT NULL DEFAULT 'chat'
    CHECK (kind IN ('chat', 'plumbing'));
