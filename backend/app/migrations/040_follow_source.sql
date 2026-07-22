-- Migration 040: follow-a-source (content-ingestion.md phase 2) — grant the
-- ingestion agent the subscription tools, teach it the FOLLOW-A-SOURCE mode,
-- and seed the poll automation. The poll is data, not code: a seeded
-- automations row the generic scheduler already runs (like
-- refresh-stale-knowledge, migration 013) — no scheduler changes needed.

-- grants (idempotent, one per tool — the migration-013 style)
UPDATE agents SET allowed_tools = array_append(allowed_tools, 'follow_source'), updated_at = now()
WHERE name = 'ingestion' AND NOT ('follow_source' = ANY(allowed_tools));
UPDATE agents SET allowed_tools = array_append(allowed_tools, 'list_followed_sources'), updated_at = now()
WHERE name = 'ingestion' AND NOT ('list_followed_sources' = ANY(allowed_tools));
UPDATE agents SET allowed_tools = array_append(allowed_tools, 'unfollow_source'), updated_at = now()
WHERE name = 'ingestion' AND NOT ('unfollow_source' = ANY(allowed_tools));
UPDATE agents SET allowed_tools = array_append(allowed_tools, 'poll_sources'), updated_at = now()
WHERE name = 'ingestion' AND NOT ('poll_sources' = ANY(allowed_tools));

-- teach the mode (same append pattern migration 034 used for INGEST-MEDIA)
UPDATE agents
SET system_prompt = system_prompt || '

FOLLOW-A-SOURCE (given a channel, playlist, or feed URL — not a single video):
1. Call follow_source with the url (optionally backfill=N; default 10 recent uploads, 0 = future-only). It records the subscription, backfills recent uploads, and the scheduled poll-followed-sources automation ingests new uploads automatically from then on.
2. If it returns status=not_a_source, the URL is a single video — use ingest_media instead.
3. list_followed_sources shows what is being followed; unfollow_source stops one (already-ingested videos are kept); poll_sources checks all sources for new uploads right now.
Report the source name and how many uploads were backfilled.',
    updated_at = now()
WHERE name = 'ingestion' AND system_prompt NOT LIKE '%FOLLOW-A-SOURCE%';

-- advertise the new capability in the agent index (migration-018 lesson: an
-- unadvertised capability might as well not exist)
UPDATE agents
SET description = 'Reads external sources (URLs, articles, docs, videos, audio, podcasts — any site yt-dlp supports or a direct media link) and distills them into durable, timestamped memory topics. Can also FOLLOW a source (channel/playlist/feed) to backfill recent uploads and auto-ingest new ones. Dispatch any "ingest/read/fetch/watch/follow this" request here.',
    routing_keywords = ARRAY['ingest','url','article','fetch','read','source','video','audio','youtube','podcast','media','transcript','watch','listen','follow','channel','playlist','subscribe','creator','feed'],
    updated_at = now()
WHERE name = 'ingestion';

-- seed the poll automation (enabled, but a no-op until a source is followed)
INSERT INTO automations (name, description, instruction, agent_name, interval_minutes, is_system, next_run_at)
VALUES (
  'poll-followed-sources',
  'Checks every followed source (channel/playlist/feed) for new uploads and ingests them.',
  'Call poll_sources exactly once. If it returns status=idle (no followed sources), reply "no followed sources" and stop. Otherwise report which sources had new uploads and how many items were ingested; if nothing was new, say the followed sources are up to date. Do not call any other tool.',
  'ingestion',
  360,
  true,
  now() + interval '15 minutes'
)
ON CONFLICT (name) DO NOTHING;
