-- Migration 033: media ingestion ledger — dedupe + provenance for the new
-- ingest_media tool (docs/plans/content-ingestion.md, phase 1). Source
-- -neutral key straight from yt-dlp ("<extractor>:<id>"), mirroring the
-- <extractor>:<id> identity the original video-ingestion.md spec designed.
-- Kept separate from web-page ingestion's dedupe (search_memory + item_id
-- pin) deliberately — that path already works and isn't touched here; see
-- the plan's "Data model" section for the reasoning.

CREATE TABLE IF NOT EXISTS media_ingests (
    media_key          TEXT PRIMARY KEY,   -- "<extractor>:<id>"
    extractor          TEXT NOT NULL,
    title              TEXT,
    url                TEXT NOT NULL,      -- canonical webpage_url
    duration_s         INTEGER,
    transcript_source  TEXT,               -- captions | whisper
    language           TEXT,
    segment_count      INTEGER,
    full_transcript_item_id TEXT,          -- memory item id of the mechanically
                                            -- written full-transcript note
    status             TEXT NOT NULL DEFAULT 'ok',  -- ok | failed | skipped
    ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
