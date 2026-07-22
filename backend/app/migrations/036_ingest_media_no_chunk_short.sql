-- Migration 036: stop over-chunking short media. The ingest_media tool now
-- short-circuits for short transcripts (<= _CHUNK_MIN_CHARS) — it returns no
-- segments and a "do not split" note, since the single full-transcript note is
-- enough. But the ingestion agent's standing INGEST-MEDIA step 4 said to chunk
-- unconditionally, and the prompt won over the per-call note: a 19-second,
-- 259-char clip got shattered into three micro-notes (verified live
-- 2026-07-21). This makes step 4 DEFER to the tool's note — chunk only when it
-- actually returns segments.

UPDATE agents
SET system_prompt = regexp_replace(
    system_prompt,
    '4\. Otherwise, write CHUNKED, TIMESTAMPED notes for good retrieval: group the returned segments',
    '4. Otherwise, follow ingest_media''s own note. When it reports the transcript is short and returns no segments, the single full-transcript note from step 1 is already the whole thing — do NOT split it into chunks (that just makes redundant micro-notes); report it is ingested and stop. When it returns segments to chunk, write CHUNKED, TIMESTAMPED notes for good retrieval: group those segments'),
    updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt LIKE '%4. Otherwise, write CHUNKED%';
