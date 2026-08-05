-- Migration 096: she can tell whether he can actually open it.
--
-- Companion to 095. That one let her read WHY a service failed; this one lets
-- her answer the question Jeremy actually asks, which is not "is it running"
-- but "can I get to it from my phone".
--
-- Those are genuinely different, and 2026-08-05 proved it three ways in one
-- afternoon: Home Assistant was healthy with its port published and answering
-- 200 on the host, while (a) tailscale was not serving it at all, then (b) it
-- was served and answering 400 because the app refused proxied requests, then
-- (c) the route was serving raw TCP and worked. `service_status` reports
-- "healthy" for every one of those states. Each was diagnosed by a human with
-- curl, and `fetch_url` cannot replace that curl — `net_guard` allow-lists
-- globally routable addresses and deliberately excludes CGNAT
-- (100.64.0.0/10, Tailscale's range), so the model cannot reach tailnet peers.
-- That boundary is correct and stays. `check_service_reachable` asks only
-- about this install's own services, by name, from the set docker reports.
--
-- MAIN and DEPLOYER, the same pair as 095 and for the same reason: main is
-- asked whether a thing works, deployer is the agent that started it.

UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['check_service_reachable'],
    updated_at = now()
WHERE name IN ('main', 'deployer')
  AND allowed_tools IS NOT NULL
  AND NOT ('check_service_reachable' = ANY(allowed_tools));
