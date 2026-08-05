-- Migration 099: she can hand a waiting job the operator's answer.
--
-- The last link in phase 3, and the run that proved it was missing is worth
-- keeping. A step-based deploy stopped at its cursor, asked "what timezone is
-- the house in?" in chat, and the prompt block correctly put that question in
-- front of her every turn. Jeremy answered — "we're in New York" — and she
-- replied "America/New_York — got it ... Home Assistant should be coming up
-- now."
--
-- It was not coming up. The run was still blocked, because `answer_task` was
-- a tool she did not hold, so there was no way for his words to reach the
-- step that asked. She had the question, she had the answer, and the two
-- could not meet.
--
-- MAIN only. Answering is a conversation act and main is the agent in the
-- conversation; a specialist that raised the card is not the one being
-- talked to. The tool itself refuses anything that is not a blocked run in
-- THIS conversation, so the grant is the whole permission.

UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['answer_task'],
    updated_at = now()
WHERE name = 'main'
  AND allowed_tools IS NOT NULL
  AND NOT ('answer_task' = ANY(allowed_tools));
