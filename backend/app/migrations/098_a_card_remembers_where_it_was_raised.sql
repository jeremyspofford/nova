-- Migration 098: a card remembers which conversation it came from.
--
-- Phase 3's missing link, found by running it. A step raised its question,
-- the run parked on it correctly — and the question reached nobody, because
-- `action_runs.conversation_id` was NULL and there was nothing to fill it
-- from. A run that stops to ask and asks into the void is worse than one that
-- never stops: it holds its recommendation open forever waiting on an answer
-- the operator was never shown.
--
-- Jeremy's instruction was specific: "Questions, if any, that need
-- clarification from me for nova, should be asked via chat." Chat means A
-- conversation, and the only one that can be right is the one the card was
-- raised in — that is where he was talking about the thing.
--
-- So `recommendations` records it at raise time (she has it on the tool ctx),
-- and `recommendations.decide()` copies it onto the run it enqueues. Two
-- columns rather than a join, because a card can be raised by an automation
-- with no conversation at all and the run still has to be enqueueable: NULL
-- there means "nowhere to ask", which `_block` already handles by leaving the
-- question on the row for the inbox.

ALTER TABLE recommendations
    ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- Backfill: the Home Assistant card raised during this build is the only row
-- that both has a step-based action and an obvious home. Left NULL for
-- everything else rather than guessed — a question delivered to the wrong
-- thread is worse than one that waits in the inbox.
UPDATE recommendations r
   SET conversation_id = (
       SELECT m.conversation_id FROM messages m
        WHERE m.created_at <= r.created_at
        ORDER BY m.created_at DESC LIMIT 1)
 WHERE r.conversation_id IS NULL
   AND r.action IS NOT NULL
   AND r.action->>'type' = 'home_assistant.deploy';
