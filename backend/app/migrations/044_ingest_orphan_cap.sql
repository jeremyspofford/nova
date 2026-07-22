-- Migration 044: cap how many times an interrupted ingest job is resumed.
--
-- reset_orphans() requeues any job left 'running' when the process died — the
-- right call for a normal restart (a shutdown shouldn't fail a job, and the
-- media_ingests ledger dedupes so re-running is safe). But it requeued WITHOUT
-- any bound, so a job that never survives to completion — e.g. a long whisper
-- transcription repeatedly cut short — retries forever with zero progress. Seen
-- 2026-07-22: a --reload storm (24 reloads in 20 min from a parallel session
-- editing backend files) orphaned one long job ~26 times, blocking the queue.
--
-- `orphans` is a SEPARATE budget from the error-retry counter (attempts /
-- max_attempts): interruptions and extraction errors are different failure
-- modes. reset_orphans bumps this per resume and parks the job 'failed' once it
-- crosses the cap (still Retry-able by the operator).

ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS orphans INTEGER NOT NULL DEFAULT 0;
