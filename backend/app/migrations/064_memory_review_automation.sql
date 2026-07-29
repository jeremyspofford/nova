-- The automation that REVIEWS instead of working.
--
-- Jeremy, 2026-07-27: Nova should have proposed the summariser herself when
-- he asked her to follow four YouTube channels. She did not, and the reason
-- is structural rather than a failure of character: every live automation
-- does work — poll-followed-sources FETCHES, refresh-stale-knowledge
-- REFRESHES, tech-news-digest WRITES. Not one of them looks at what is
-- piling up. `raise_recommendation` and the inbox already shipped, so the
-- output path was never the blocker either.
--
-- The other half was that nothing recorded WHICH documents retrieval
-- returned, only how many characters — so "82 transcripts, none ever used"
-- was not a fact anybody could compute. The runner now stamps memory_ids on
-- every memory_retrieval span and memory_usage_report does the arithmetic.
-- This is the reader of that number.
--
-- Its instruction says explicitly NOT to do work. Given an ingestion agent
-- and a report about unused videos, a model that is allowed to act will go
-- and ingest more; the whole value here is noticing, and the operator's
-- approval click is what turns a notice into a change.
--
-- Weekly (10080 minutes) because the signal moves on the scale of a
-- retention window, not a day, and DISABLED by default: it writes to the
-- recommendations inbox, and switching on something that starts putting
-- cards in front of the operator is his call, not this migration's.

INSERT INTO automations (name, description, instruction, agent_name,
                         interval_minutes, enabled, is_system)
VALUES (
  'review-memory-usage',
  'Weekly: compare what memory is collecting against what actually gets used, and raise recommendations.',
  E'You are REVIEWING, not working. Do not ingest, fetch, refresh, write or delete anything during this run — the only durable output you may produce is a recommendation card.\n\n'
  'Call memory_usage_report (try days=14). It returns, per source: how many documents exist, how many were ever retrieved into an answer, and how many retrievals happened. Those numbers are computed for you — use them, do not recompute or estimate them.\n\n'
  'Then judge, and raise a recommendation with raise_recommendation ONLY where a number genuinely warrants it. Cases worth raising:\n'
  '- a followed source with many documents and near-zero retrievals: it may not be earning its slot, or its material may need distilling to be findable.\n'
  '- a large group of documents where the raw text is retrieved but no distilled form exists.\n'
  '- anything accumulating faster than it is used.\n\n'
  'Rules. One card per finding, at most three per run; use a stable dedupe_key so a standing issue does not re-raise every week. Quote the actual counts in the body — a recommendation without its number is an opinion. If every source looks reasonably used, raise NOTHING and say so in your summary; a review that always finds something is a review nobody reads.\n\n'
  'Remember the report''s own caveat: retrieval evidence only goes back as far as trace retention, so a low count on old documents can mean the evidence expired rather than that nothing used them. Say which it is when you can tell, and prefer to under-claim.',
  'ingestion',
  10080,
  false,
  false
)
ON CONFLICT (name) DO NOTHING;

-- The report tool, granted to the agent that runs the review. Read-only, so
-- it widens nothing: it names documents the agent could already search.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['memory_usage_report']) AS t)
 WHERE name = 'ingestion'
   AND allowed_tools IS NOT NULL
   AND NOT ('memory_usage_report' = ANY(allowed_tools));
