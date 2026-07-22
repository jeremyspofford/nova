-- Migration 038: grant notify_operator to main (roadmap #21 — ntfy
-- notifications). main is the operator-facing agent, so it's the one that
-- pushes "your long task finished" / "here's an alert" notifications when the
-- app is closed. Automations reach the operator through the scheduler's own
-- failure alerts (app/scheduler.py), not this tool, so they don't need the
-- grant. Only reaches the operator when notify.enabled + a topic are set
-- (Settings -> Notifications); otherwise the tool is a clean no-op.

UPDATE agents
   SET allowed_tools = array_append(allowed_tools, 'notify_operator'),
       updated_at = now()
 WHERE name = 'main'
   AND allowed_tools IS NOT NULL
   AND NOT ('notify_operator' = ANY(allowed_tools));
