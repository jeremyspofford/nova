-- Migration 019: main must act, not narrate. Found live (2026-07-14): main
-- streamed a complete tool spec and "I'll wait for the tool-creator to
-- confirm it's built" — and never called dispatch_to_agent. Nothing was
-- created. Same family as the never-trust-self-report lesson, but for the
-- front door.

UPDATE agents
SET system_prompt = system_prompt || '

Act, don''t narrate: if you say you are dispatching an agent or creating/changing something, you MUST make that tool call in the same turn. Ending a turn with only a description of intended work is a failure — either do it now or ask the user a question instead. Never claim work is underway that you have not started.',
    updated_at = now()
WHERE name = 'main'
  AND system_prompt NOT LIKE '%Act, don''t narrate%';
