-- Migration 034: media ingestion — the existing ingestion agent gains an
-- INGEST-MEDIA mode (videos, audio, direct media URLs via the new `media`
-- worker + ingest_media tool) alongside its existing INGEST/REFRESH/RESEARCH
-- modes for web content. Same agent, same memory machinery, same dedupe
-- philosophy — only the extraction mechanism differs by content kind
-- (docs/plans/content-ingestion.md). Also tags curated models for the new
-- dedicated 'ingestion' role (model_recs.py, curated_models.py) so Detect &
-- suggest sizes this agent instead of borrowing the generic 'tools' profile.

UPDATE agents
SET allowed_tools = array_append(allowed_tools, 'ingest_media'),
    updated_at = now()
WHERE name = 'ingestion'
  AND NOT ('ingest_media' = ANY(allowed_tools));

UPDATE agents
SET system_prompt = system_prompt || '

INGEST-MEDIA (given a video, audio, or other media URL — any site yt-dlp supports, or a direct .mp4/.webm/.mp3 link):
1. Call ingest_media with the url. It mechanically extracts captions (or falls back to transcribing the audio) and ALREADY saves the full transcript to memory and records it as ingested — that safety net exists regardless of what you do next.
2. If the result says status=already_ingested, tell the user it is already in memory (mention the title) and stop; only pass force=true if they explicitly ask to re-ingest.
3. If the result says status=skipped, relay the reason (e.g. a live stream has no final transcript) and stop.
4. Otherwise, write CHUNKED, TIMESTAMPED notes for good retrieval: group the returned segments by chapter when chapters are given, else into spans of roughly 1-2k characters. For each chunk, call write_memory (type=topic, title="<title> — <chapter or mm:ss-mm:ss>", category=knowledge, 2-4 tags, source_url=that chunk''s own deep_link from its first segment — never construct a timestamp URL yourself, always use the one the tool gave you).
5. Unlike web distillation, PRESERVE the transcript''s actual wording per chunk — light cleanup of filler/disfluencies only, never summarize away content; the exact record is already searchable in full via the transcript note from step 1, so chunks exist for citeable, timestamped retrieval, not compression.
6. Report the title, how many chunks you wrote, and the transcript source (captions or whisper).',
    updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt NOT LIKE '%INGEST-MEDIA%';

-- advertise the new capability in the agent index, or main never dispatches
-- here for media requests (migration-018 lesson: an unadvertised capability
-- might as well not exist — "I can't inspect hardware" until the index said
-- otherwise)
UPDATE agents
SET description = 'Reads external sources (URLs, articles, docs, videos, audio, podcasts — any site yt-dlp supports or a direct media link) and distills them into durable, timestamped memory topics. Dispatch any "ingest/read/fetch/watch/listen to this" request here.',
    routing_keywords = ARRAY['ingest','url','article','fetch','read','source','video','audio','youtube','podcast','media','transcript','watch','listen'],
    updated_at = now()
WHERE name = 'ingestion';

-- the dedicated 'ingestion' role: large context for full transcripts/long
-- articles, cheap enough to run on schedules, faithful extraction over
-- conversational style, tool-capable; latency doesn't matter (batch/
-- background work). Cloud default stays glm-5.2 (1M context, already this
-- agent's model, no new key). Local alternates span the hardware range:
-- gemma4:e2b is the CPU-only floor (128K context, already documented in its
-- notes), qwen3:14b/qwen3:32b are the GPU-tiered tool-A picks.
UPDATE curated_models
SET roles = array_append(roles, 'ingestion'), updated_at = now()
WHERE model IN ('openrouter:z-ai/glm-5.2', 'ollama:gemma4:e2b',
                'ollama:qwen3:14b', 'ollama:qwen3:32b')
  AND NOT ('ingestion' = ANY(roles));
