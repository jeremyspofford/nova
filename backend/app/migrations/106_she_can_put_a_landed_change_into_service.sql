-- Migration 106: she can put a landed change into service.
--
-- The loop could write a change, boot it in a sandbox against his real data,
-- have a second model read it, and place it on a branch in his repo. Then it
-- stopped — because a landed branch is not a running one, and picking it up
-- meant Jeremy typing `docker compose build`. Every improvement she has ever
-- made reached the running stack by his hand.
--
-- Found the way all of these are found: proving the retry path needed a change
-- to `coder/broker.py`, and there was no way for her to deploy it. The gap was
-- invisible from the code and obvious the moment the work needed doing.
--
-- FIFTH TIME for this pattern in two sessions — `service_logs` (095),
-- `check_service_reachable` (096), `answer_task` (099), `sandbox_check` and
-- `review_code` (104). A tool is not a capability until an agent holds it.
--
-- MAIN, because main is the agent in the conversation and this is the last
-- step of work she is already driving: she delegates the coding, verifies it
-- in the sandbox, asks for the review, and raises the landing card he
-- approves. What she could not do is the one thing that makes any of it real.
--
-- WHAT IT CANNOT DO, so that granting it stays a small decision:
--   * `backend` is refused in the tool — recreating the service running the
--     turn means nothing could report the outcome, and an unverifiable success
--     is the outcome worth refusing;
--   * `inference-control` is refused by the sidecar, derived from its own
--     container labels rather than written down;
--   * the name is checked against this compose project's own service labels
--     before it reaches a subprocess, so an unknown value is an error and
--     never an argument;
--   * `--no-deps`, so redeploying `web` cannot recreate postgres underneath a
--     running backend.

UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['redeploy_service'],
    updated_at = now()
WHERE name = 'main'
  AND allowed_tools IS NOT NULL
  AND NOT ('redeploy_service' = ANY(allowed_tools));
