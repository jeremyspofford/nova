-- retry_ingest_job: let her act on a failed ingest, once, and no more.
--
-- On 2026-08-02 the operator pointed at two failed rows on the Activity page.
-- Reading them is the census (app/failures.py); this is the other half of what
-- he asked for — that she can FIX, not only explain.
--
-- The budget is a column, not a sentence. `ingest_jobs.retry()` — the
-- operator's Retry button — resets attempts AND orphans to zero, so an
-- unbounded model loop would defeat both max_attempts (3) and MAX_ORPHANS (5)
-- and could re-run an expensive transcription forever. `agent_retries` is an
-- error budget she cannot reset: the only statement in the codebase that
-- returns it to zero is that operator retry, reachable solely from the
-- authenticated HTTP endpoint. She spends it; a human refills it.
--
-- One is the right number for today's two failures: both are members-only
-- YouTube videos at attempts 3/3, where retrying is known-useless. The budget
-- exists so that being wrong about that costs one re-run, not a loop.

ALTER TABLE ingest_jobs
  ADD COLUMN IF NOT EXISTS agent_retries INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN ingest_jobs.agent_retries IS
  'Retries spent by an agent. Only the operator retry (ingest_jobs.retry) '
  'resets it — the model has no path to zero it.';

-- Granted to main only. main is who the operator talks to and therefore who
-- gets asked about the Activity page; guardian judges whether an action is
-- safe and does not remediate. Every agent row has a non-NULL allowed_tools,
-- so without this grant the tool is invisible to all of them.
UPDATE agents
   SET allowed_tools = array_append(allowed_tools, 'retry_ingest_job')
 WHERE name = 'main'
   AND allowed_tools IS NOT NULL
   AND NOT ('retry_ingest_job' = ANY(allowed_tools));
