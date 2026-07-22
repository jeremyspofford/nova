"""Media ingestion ledger — dedupe + provenance, mechanical rather than
LLM-judged. The ingest_media tool records a row here BEFORE handing control
back to the agent to write chunked notes, so a video is never double
-ingested regardless of how the agent's chunking pass goes (or a future
followed-source poll re-discovering the same item). Migration 033.
Source-neutral key: "<extractor>:<id>", straight from yt-dlp.
"""

from typing import Optional

from app import db


async def get(media_key: str) -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM media_ingests WHERE media_key = $1", media_key)
    return dict(row) if row else None


async def record(*, media_key: str, extractor: str, title: str, url: str,
                 duration_s: Optional[int], transcript_source: str,
                 language: Optional[str], segment_count: int,
                 full_transcript_item_id: Optional[str],
                 status: str = "ok", source_key: Optional[str] = None) -> dict:
    """Upsert on media_key — a forced re-ingest (force=true) refreshes the
    ledger row in place rather than erroring on the unique key. source_key
    stamps the followed source that discovered this item (phase 2); a later
    one-off ingest of the same item (source_key=None) never wipes it."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO media_ingests
                 (media_key, extractor, title, url, duration_s,
                  transcript_source, language, segment_count,
                  full_transcript_item_id, status, source_key)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (media_key) DO UPDATE SET
                 title = EXCLUDED.title, url = EXCLUDED.url,
                 duration_s = EXCLUDED.duration_s,
                 transcript_source = EXCLUDED.transcript_source,
                 language = EXCLUDED.language,
                 segment_count = EXCLUDED.segment_count,
                 full_transcript_item_id = EXCLUDED.full_transcript_item_id,
                 status = EXCLUDED.status,
                 source_key = COALESCE(EXCLUDED.source_key, media_ingests.source_key),
                 updated_at = now()
               RETURNING *""",
            media_key, extractor, title, url, duration_s, transcript_source,
            language, segment_count, full_transcript_item_id, status, source_key)
    return dict(row)
