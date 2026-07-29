-- diagnose: let her look at her own configuration before explaining it.
--
-- Asked why push notifications had stopped, Nova offered to investigate and
-- had no way to. The cause was one unset value — Apple's push relay rejects a
-- non-routable VAPID contact with a bare 403 — which is a thing you find by
-- LOOKING, not by reasoning.
--
-- Granted to main and guardian: main because it is who gets asked, guardian
-- because judging whether an action is safe needs the current configuration.
-- Read-only, so it classifies as a READER under the containment fence and
-- carries no new trust.

UPDATE agents
   SET allowed_tools = array_append(allowed_tools, 'diagnose')
 WHERE name IN ('main', 'guardian')
   AND allowed_tools IS NOT NULL
   AND NOT ('diagnose' = ANY(allowed_tools));
