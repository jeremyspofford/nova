-- Grant the goal verbs to the agents whose job they are.
--
-- `propose_goal` goes to main because main is who Jeremy is talking to when
-- he asks for something she cannot yet do. A specialist that hits the goal
-- gate reports the refusal upward; it does not negotiate its own scope,
-- which keeps "who may ask for more power" to exactly one place.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['propose_goal','list_goals']) AS t),
       updated_at = now()
 WHERE name = 'main' AND allowed_tools IS NOT NULL;

-- `manage_tool_hosts` goes to tool-creator, the agent that already owns
-- `manage_tools` and therefore already hits the allowlist. Splitting them
-- would mean the agent that discovers the host is refused is not the agent
-- that can request it.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['manage_tool_hosts']) AS t),
       updated_at = now()
 WHERE name = 'tool-creator' AND allowed_tools IS NOT NULL;

-- Tell main the shape of the thing, because a tool she does not know the
-- PURPOSE of is a tool she uses at the wrong moment. The important sentence
-- is the last one: the refusal is not a dead end, and she should say so
-- rather than reporting that she is not allowed.
UPDATE agents
   SET system_prompt = system_prompt || E'\n\nWhen the operator asks for something you cannot do yet — a new integration, a service to manage, a workflow that needs tools you do not have — do not answer with what you are not allowed to do. Work out what would be needed, then call propose_goal with a finish line they can check and the verbs it needs. One approval covers the whole build, so ask once for the goal instead of once per step. list_goals tells you what is already approved and how many actions remain; check it before saying you need permission.',
       updated_at = now()
 WHERE name = 'main'
   AND system_prompt NOT LIKE '%propose_goal%';
