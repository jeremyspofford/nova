-- Phase 2 ergonomics: Nova can learn WHICH credentials exist, never a value.
--
-- The point is a conversation that goes somewhere. Before this, asked to wire
-- an integration that needs a token she had no way to know whether one was
-- already stored, so the honest answer was always "I need a token" even when
-- the operator had put one there an hour earlier.
--
-- Names only. There is no tool that returns a value and none is planned: a
-- value path reachable by a model is a value that reaches a model.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['list_secret_names']) AS t),
       updated_at = now()
 WHERE name IN ('main', 'tool-creator')
   AND allowed_tools IS NOT NULL
   AND NOT ('list_secret_names' = ANY(allowed_tools));

UPDATE agents
   SET system_prompt = system_prompt || E'\n\nCredentials live in the operator''s secret store and you can see their NAMES with list_secret_names, never their values. When something needs a token, check whether one is already stored and reference it as {{secret:<name>}}; if it is missing, ask him to add it in Settings -> Secrets. Never ask him to paste a token into a chat message or into a tool argument.',
       updated_at = now()
 WHERE name = 'tool-creator'
   AND system_prompt NOT LIKE '%list_secret_names%';
