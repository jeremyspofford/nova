-- Migration 053: move the durability rails to the END of the ingestion
-- prompt, where this codebase has repeatedly learned that must-win
-- instructions have to sit.
--
-- 051 added them and 052 tightened them, and the behavior did not move: the
-- agent kept appending "a May 2026 leak claimed 2T params / 1M context —
-- superseded" to a durable topic across five graded runs. The rules were
-- landing in the MIDDLE of the prompt — tag hygiene, the whole INGEST-MEDIA
-- section and the whole FOLLOW-A-SOURCE section all came after them, and the
-- runner appends its house rules after that again.
--
-- Same text, last position. Nothing else changes, so if the behavior still
-- does not move, the finding is behavioral rather than positional and
-- belongs in front of Jeremy rather than in another migration.

UPDATE agents SET
  system_prompt = replace(system_prompt,
                          E'\n\nSHELF LIFE (every mode): a topic is a DURABLE record. Facts that expire — opening hours, today''s closure, live status, current prices, queue lengths, "as of this morning" figures — go in your reply, never into stored memory. The test is simple: if it would be wrong next week and no one would notice, it does not belong in a topic. Durable facts about the same subject (what a place IS, when it was founded, what it holds) are exactly what you should keep.

WHEN SOURCES DISAGREE: the authoritative and most recent source wins — a vendor''s own page over a leak or rumor, a shipped spec over a pre-release claim, a correction over the post it corrects (including an update note further down the same page you already fetched). A superseded figure does not go into the topic AT ALL — not even to debunk it. "The leak claimed X, which was wrong" still leaves X sitting in memory, where a later search will surface it without the caveat attached. Note the discrepancy in your REPLY if it matters; the topic records only what is true now.\n\n', E'\n\n')
                  || E'\n\nSHELF LIFE (every mode): a topic is a DURABLE record. Facts that expire — opening hours, today''s closure, live status, current prices, queue lengths, "as of this morning" figures — go in your reply, never into stored memory. The test is simple: if it would be wrong next week and no one would notice, it does not belong in a topic. Durable facts about the same subject (what a place IS, when it was founded, what it holds) are exactly what you should keep.

WHEN SOURCES DISAGREE: the authoritative and most recent source wins — a vendor''s own page over a leak or rumor, a shipped spec over a pre-release claim, a correction over the post it corrects (including an update note further down the same page you already fetched). A superseded figure does not go into the topic AT ALL — not even to debunk it. "The leak claimed X, which was wrong" still leaves X sitting in memory, where a later search will surface it without the caveat attached. Note the discrepancy in your REPLY if it matters; the topic records only what is true now.',
  updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt LIKE '%SHELF LIFE (every mode): a topic is a DU%';
