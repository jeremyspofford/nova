-- refresh-stale-knowledge: drop the instruction that states a falsehood.
--
-- Migration 013 seeded this automation telling the agent that when a source
-- will not fetch it should "update the topic adding a note that the source
-- appears dead — that removes it from the stale list." It does not. The note
-- is prose in the BODY, the stale list is selected from FRONTMATTER, and the
-- write bumps the topic's timestamp, so the topic comes back looking freshly
-- learned. The agent followed that instruction faithfully across 50 runs and
-- the same three 2026-07-22 YouTube videos stayed at the head of the queue.
--
-- Editing 013 in place would change nothing: db.py:59-82 keys the migration
-- ledger on filename and skips anything already recorded, and this install's
-- checksum for 013_automations.sql is NULL, so not even the drift warning
-- would fire. The live row is the only thing that matters, so update it here.
--
-- The real fix is mechanical and lives in code — memory/immutable.py excludes
-- recordings, followed-source pages and summaries from the selector before
-- the agent ever sees them. This migration only stops the prompt asking for
-- a remedy that cannot work.
--
-- The literal "nothing stale" is load-bearing: scheduler.py:175 suppresses
-- the journal entry for a clean run by matching that exact string. Keep it.
--
-- The LIKE guard makes this idempotent and makes it decline to clobber a
-- hand-rewritten instruction.

UPDATE automations SET
  instruction = 'Call list_stale_topics. If it returns nothing, reply "nothing stale" and stop. Otherwise refresh up to 3 of the OLDEST topics using your REFRESH workflow: read_memory_item to get each topic''s content and source_url, re-fetch the source, and write_memory WITH item_id so the topic updates in place. If a topic''s source fails to fetch, say so in your report and move on — do NOT write a note into the topic saying the source is dead. That note is body prose, the stale list is selected from frontmatter, and the write bumps the topic''s timestamp, so it would come back looking freshly learned. Recordings, followed-channel pages and summary notes are excluded mechanically before you see the list; the skipped counts tell you how many, and there is nothing to do about them. Finish with a short report of what you refreshed and what changed.',
  updated_at = now()
WHERE name = 'refresh-stale-knowledge'
  AND instruction LIKE '%that removes it from the stale list%';
