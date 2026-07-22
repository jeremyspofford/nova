-- Migration 039: follow-a-source (content-ingestion.md phase 2). A "source" is
-- a channel / playlist / feed page; following it backfills recent uploads and a
-- scheduled poll ingests new ones as they appear. Source-neutral like the
-- media_ingests ledger: source_key = "<extractor>:<id>" straight from yt-dlp, so
-- following works on any site yt-dlp can enumerate, not just YouTube.

CREATE TABLE IF NOT EXISTS source_subscriptions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key     TEXT NOT NULL UNIQUE,          -- "<extractor>:<id>" — dedupe/identity
    url            TEXT NOT NULL,                  -- canonical source page URL
    extractor      TEXT NOT NULL,
    title          TEXT,                           -- source / channel name
    backfill       INTEGER NOT NULL DEFAULT 10,    -- recent uploads ingested on follow; 0 = future-only
    enabled        BOOLEAN NOT NULL DEFAULT true,  -- kill switch — stops the poll
    ingested_count INTEGER NOT NULL DEFAULT 0,     -- items ingested from this source so far
    last_polled_at TIMESTAMPTZ,
    last_status    TEXT,                           -- ok | error
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link ingested items back to the source that discovered them. Migration 033
-- deliberately omitted this column until the feature existed (no speculative
-- schema); nullable, because one-off ingests have no source.
ALTER TABLE media_ingests ADD COLUMN IF NOT EXISTS source_key TEXT;
CREATE INDEX IF NOT EXISTS media_ingests_source_key_idx ON media_ingests (source_key);
