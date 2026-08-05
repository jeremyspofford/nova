-- Migration 095: she can read the logs of the services she is made of.
--
-- Jeremy, 2026-08-05, after watching me diagnose a Home Assistant failure by
-- hand and report the answer back to him:
--
--     "when we hit friction with nova, you need to fix nova to give her the
--      capabilities to do so, otherwise it's just you fucking doing it and
--      nova is just a fancy stupid ai."
--
-- The gap was exact. `service_status` told her a container was `exited (1)`
-- and `workload_logs` covered her Kubernetes pods, but the COMPOSE services
-- this install is made of had no log surface at all. Asked why Home
-- Assistant was refusing proxied requests, she answered "my tools can only
-- see Kubernetes workloads, not host Docker containers" and told him to run
-- `docker compose logs home-assistant` himself. Correct about her tools, and
-- exactly the outcome that makes the whole product pointless.
--
-- `service_logs` is the tool (builtin.py) reading a new sidecar endpoint that
-- validates the service name against the compose project's own labels before
-- it reaches a subprocess. This is the grant.
--
-- MAIN, because main is the agent that gets asked "why is X broken" and
-- already holds `service_status` — the tool that says something is down. The
-- pair belongs to one agent or the diagnosis stops halfway, which is what it
-- did.
--
-- DEPLOYER too: it already holds `workload_logs` for its own pods, and it is
-- the agent main dispatches deployment work to, so it is the one that will
-- be asked why a service it started did not come up.
--
-- Idempotent — the array append is guarded, so re-running changes nothing.

UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['service_logs'],
    updated_at = now()
WHERE name IN ('main', 'deployer')
  AND allowed_tools IS NOT NULL
  AND NOT ('service_logs' = ANY(allowed_tools));
