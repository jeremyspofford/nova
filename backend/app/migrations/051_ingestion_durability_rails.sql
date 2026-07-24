-- Migration 051: two rails the ingestion agent was missing, both found by the
-- eval suites grading the CHAMPION (glm-5.2) on 2026-07-24 — not a model
-- problem, a prompt problem:
--
--   * It wrote a museum's opening hours, last-admission time and today's
--     closure into a durable topic. The shelf-life rule existed, but only
--     inside RESEARCH mode's step 3 — and that task was an INGEST ("read
--     this URL and save what's worth keeping"), which had no such rule.
--     Hoisted to a rule that applies in every mode.
--   * On a research task whose mini-web plants a pre-release leak above the
--     vendor's own page, it imported the leak's superseded numbers. The
--     prompt said to PREFER authoritative sources when choosing what to
--     fetch, but said nothing about what to do once two fetched sources
--     disagree.
--
-- Surgical on purpose: this rewrites nothing. Later migrations added the
-- INGEST-MEDIA and FOLLOW-A-SOURCE sections to this same prompt, and a full
-- rewrite here would silently drop whatever lands between them and this one.
-- The nested replace() is anchored on a sentence that has survived every
-- revision, and the WHERE clause makes the whole thing a no-op if an
-- operator has since edited that line away.

UPDATE agents SET
  system_prompt = replace(
    system_prompt,
    'Keep each topic self-contained and useful to a future reader who has not seen the source.',
    'Keep each topic self-contained and useful to a future reader who has not seen the source.

SHELF LIFE (every mode): a topic is a DURABLE record. Facts that expire — opening hours, today''s closure, live status, current prices, queue lengths, "as of this morning" figures — go in your reply, never into stored memory. The test is simple: if it would be wrong next week and no one would notice, it does not belong in a topic. Durable facts about the same subject (what a place IS, when it was founded, what it holds) are exactly what you should keep.

WHEN SOURCES DISAGREE: the authoritative and most recent source wins — a vendor''s own page over a leak or rumor, a shipped spec over a pre-release claim, a correction over the post it corrects (including an update note further down the same page you already fetched). Never carry a superseded number into memory as if it were current. If the correction itself is worth recording, say plainly that the earlier figure was wrong and what replaced it.'),
  updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt LIKE '%Keep each topic self-contained and useful to a future reader who has not seen the source.%'
  AND system_prompt NOT LIKE '%SHELF LIFE (every mode)%';
