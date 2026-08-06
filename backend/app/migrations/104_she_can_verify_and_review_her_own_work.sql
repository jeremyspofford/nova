-- Migration 104: she can verify and review her own work.
--
-- Jeremy, 2026-08-06, after watching an "end to end" demonstration:
--
--     "i'm concerned with you giving nova the ability to do things I'm
--      asking. and ensuring that you don't actually go and do them for nova,
--      but instead give her what she needs"
--
-- He was right and the demonstration proved his point rather than mine. She
-- raised the build card and the loop ran — and then I drove every remaining
-- step through the operator routes with curl: the sandbox check, the review,
-- the landing. The chain worked. She could not have moved it.
--
-- Because `sandbox_check` and `review_code` were built, tested, wired into
-- the gates, and NEVER GRANTED. The tools existed; she did not hold them.
--
-- FOURTH TIME IN ONE SESSION for this exact pattern — `service_logs` (095),
-- `check_service_reachable` (096) and `answer_task` (099) each shipped as a
-- capability nobody had, and each was found the same way: by asking her to do
-- the thing and watching her explain that she could not. A tool is not a
-- capability until an agent holds it, and the gap is invisible from the code.
--
-- MAIN, because main is the agent in the conversation and these are steps in
-- work she is already driving: she delegates the coding task, so she is the
-- one who should verify it and ask for it to be read. Neither tool can act on
-- his repository — `sandbox_check` builds a throwaway stack and tears it
-- down, `review_code` hands a diff to a second model and records a verdict.
-- Landing stays a card he approves.

UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['sandbox_check', 'review_code'],
    updated_at = now()
WHERE name = 'main'
  AND allowed_tools IS NOT NULL
  AND NOT ('sandbox_check' = ANY(allowed_tools));
