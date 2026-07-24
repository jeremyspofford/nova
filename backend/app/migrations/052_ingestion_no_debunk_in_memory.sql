-- Migration 052: close a loophole migration 051 opened one run earlier.
--
-- 051's "when sources disagree" rail ended with an escape hatch: "if the
-- correction itself is worth recording, say plainly that the earlier figure
-- was wrong and what replaced it." The agent took it literally and wrote
-- this line into a durable topic:
--
--   "A pre-release leak/rumor article (May 2026) claimed 2T params and 1M
--    context for a Q4 launch — superseded and inaccurate; ignore."
--
-- Which puts the wrong numbers in memory. A future BM25 search for those
-- figures matches this note, and a snippet does not necessarily carry the
-- "superseded" clause with it — the same shape as the generic-tag
-- over-linking incident: a stray token creating a false association that
-- outlives the sentence that qualified it.
--
-- The rule is simpler than the hedge: the topic records what is TRUE.
-- Corrections are reply material.

UPDATE agents SET
  system_prompt = replace(
    system_prompt,
    'Never carry a superseded number into memory as if it were current. If the correction itself is worth recording, say plainly that the earlier figure was wrong and what replaced it.',
    'A superseded figure does not go into the topic AT ALL — not even to debunk it. "The leak claimed X, which was wrong" still leaves X sitting in memory, where a later search will surface it without the caveat attached. Note the discrepancy in your REPLY if it matters; the topic records only what is true now.'),
  updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt LIKE '%If the correction itself is worth recording%';
