-- main can read the web: the question she is actually asked most.
--
-- 2026-07-30, voice: "can you find ARIA Labs on GitHub?" She had exactly one
-- way to answer — `github-profile-fetch`, an http_call that resolves ONE exact
-- login and cannot search. A wrong guess returns a DIFFERENT REAL ACCOUNT with
-- 200 OK, and post-incident she did precisely that and reported a stranger's
-- empty profile as the answer. A curated endpoint per question is the list you
-- have to maintain forever, and it answers the wrong question confidently.
--
-- web_search + fetch_url are the general capability those wrappers approximate.
-- Both are READERS under the containment fence (registry.is_actor: BUILTIN and
-- not in ACTOR_TOOLS), so this grant carries no new trust by that measure, and
-- fetch_url already refuses private/internal addresses on its own.
--
-- KNOWN EXPOSURE, recorded rather than glossed. `untrusted_context` is set once
-- per turn from MEMORY provenance (runner.py:1499 <- prompt_signals) and is
-- never updated from a tool result, so a page fetched mid-turn does not taint
-- the turn that fetched it. That has been safe by architecture, not by the
-- fence: capability-and-containment.md:368 notes that `ingestion` handles
-- untrusted pages and "holds none of these". main holds `manage_automations`,
-- which IS an ACTOR — so after this grant the fence alone no longer separates
-- them. What still does: `manage_automations` is in GOAL_SCOPED_TOOLS, so it
-- runs only against an operator-approved goal carrying that verb.
--
-- Note this is not introduced here. `model-manager` already holds web_search
-- and `pull_model` (ACTOR) together, and has since it was seeded. Whether the
-- fence should taint in-turn is an open decision for Jeremy, because the
-- honest fix would break model-manager's entire job (search for a model, then
-- pull it) and that tradeoff is his to make, not this migration's.

UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['web_search', 'fetch_url']) AS t),
       updated_at = now()
 WHERE name = 'main'
   AND allowed_tools IS NOT NULL
   AND NOT ('web_search' = ANY(allowed_tools)
            AND 'fetch_url' = ANY(allowed_tools));
