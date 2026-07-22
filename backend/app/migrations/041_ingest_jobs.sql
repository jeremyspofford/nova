-- Migration 041: durable ingestion queue — the "background job queue" the earlier
-- content-ingestion phases deferred (docs/plans/content-ingestion.md, Polish phase).
--
-- follow_source backfill and the poll-followed-sources automation used to ingest
-- videos INLINE — inside the chat turn or the automation run. A long multi-channel
-- backfill therefore rode a single HTTP request for many minutes and was lost WHOLE
-- if the connection dropped or the process restarted (2026-07-22 incident: four
-- channels followed, the turn died after two, and no trace survived because spans
-- only flush at turn-end). This table decouples deciding-to-ingest (fast,
-- transactional, in the chat turn) from doing-it (a background worker drains this
-- queue). Rows persist, so a killed process RESUMES from here; the media_ingests
-- ledger dedupes, so re-running a job is always cheap and safe.

CREATE TABLE IF NOT EXISTS ingest_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url             TEXT NOT NULL,                    -- media URL the worker extracts
    media_key       TEXT,                             -- "<extractor>:<id>" if known at enqueue (dedupe hint); NULL for a bare URL
    title           TEXT,                             -- best-known title at enqueue, shown before extraction
    source_key      TEXT,                             -- followed source that spawned this (NULL = one-off)
    status          TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | skipped | failed
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    error           TEXT,                             -- last failure message
    result_item_id  TEXT,                             -- full-transcript memory item id on success
    enqueued_by     TEXT,                             -- provenance: follow_source | poll | ingest_media
    conversation_id UUID,                             -- chat turn that requested it, when applicable
    announced       BOOLEAN NOT NULL DEFAULT false,   -- rolled into a source's completion journal/notify yet?
    enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The worker claims the oldest queued row (FOR UPDATE SKIP LOCKED); this index
-- keeps that scan cheap and preserves FIFO order.
CREATE INDEX IF NOT EXISTS ingest_jobs_queued_idx ON ingest_jobs (status, enqueued_at);
CREATE INDEX IF NOT EXISTS ingest_jobs_source_key_idx ON ingest_jobs (source_key);

-- Never queue the same media twice while one is still pending. A NULL media_key
-- (a bare URL not yet enumerated) is exempt — NULLs are distinct in a unique index,
-- so those dedupe at the worker against the media_ingests ledger instead.
CREATE UNIQUE INDEX IF NOT EXISTS ingest_jobs_active_media_key_idx
    ON ingest_jobs (media_key) WHERE status IN ('queued', 'running');
