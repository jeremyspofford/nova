-- Dismiss an activity item — and have it stay dismissed.
--
-- The operator has two failed rows on the Activity page that will never
-- succeed: both are members-only YouTube uploads on a channel he is not going
-- to join. He asked for a way to clear them off the list.
--
-- WHY A COLUMN AND NOT A DELETE. Deleting the row is the obvious answer and it
-- is the wrong one, because the row is the only thing standing between those
-- videos and the next poll. `_enqueue_source_entries` looks each candidate up
-- with `find_open(media_key)`: a failed row is REVIVED (ingest_jobs.retry),
-- and no row at all is ENQUEUED FRESH. Both branches put the video back in the
-- queue within the hour, it burns three download attempts against a paywall,
-- and it lands back on the page it was just cleared from. A delete would make
-- the button a cosmetic lie that also costs bandwidth.
--
-- So dismissal is a tombstone. The row survives with `dismissed_at` set, it is
-- hidden from the panel and from the failure census, and the poll reads it as
-- "the operator has decided about this one" and skips it. purge_old is
-- deliberately left alone — it sweeps only done/skipped, so a dismissed
-- FAILED row is never reaped and the tombstone is permanent.
--
-- DISMISSAL IS THE OPERATOR'S ALONE. There is no tool and no agent path to
-- this column, by design: it suppresses rows from failures.census, so a model
-- that could dismiss could silence its own failures — the one thing that
-- module exists to make impossible. `retry_by_agent` gains a dismissed_at
-- guard for the same reason, and restoring is an HTTP endpoint behind the auth
-- middleware, like the Retry button.

ALTER TABLE ingest_jobs
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN ingest_jobs.dismissed_at IS
  'Operator cleared this row off the Activity page. Hides it from the panel '
  'and from failures.census, and stops the followed-source poll re-queueing '
  'the same media_key. Operator-only: no tool writes this.';

-- Partial: the common read is "not dismissed", and the dismissed set stays
-- small enough that its own scan is free.
CREATE INDEX IF NOT EXISTS ingest_jobs_dismissed_idx
  ON ingest_jobs (dismissed_at) WHERE dismissed_at IS NOT NULL;
