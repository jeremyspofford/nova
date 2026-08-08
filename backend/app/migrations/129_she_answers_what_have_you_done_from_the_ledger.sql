-- Migration 129: she answers "what have you done?" from the ledger.
--
-- The follow-up migration 123 wrote down instead of half-building: the action
-- log it indexed is an OPERATOR surface, and the tool it makes obvious —
-- `list_recent_actions`, wrapping `activity_log.fetch` — needed files outside
-- that lane. The tool now exists in `app/tools/builtin.py`; this migration is
-- the other half of the repo's rule that a tool is not a capability until an
-- agent holds it (missed FIVE times in one session: 095, 096, 099, 104, 106).
--
-- WHY. The forged-receipt failure class: she has claimed refused calls as
-- done, quoted a diffstat nobody produced, and invented a session id — each
-- time answering "what did you do?" from the transcript, where her own claims
-- live. `turn_spans` and its sibling records are what actually ran, refusals
-- included. Read-only (the same rows migration 123 indexed), so the grant
-- widens what she can SEE and nothing she can do.
--
-- main only, per 123's spec ("so SHE can answer 'what have you actually done
-- today?'"): main is the agent the operator asks. Specialists can be granted
-- later if the question ever reaches them.

UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['list_recent_actions'],
    updated_at = now()
WHERE name = 'main'
  AND allowed_tools IS NOT NULL
  AND NOT ('list_recent_actions' = ANY(allowed_tools));

-- ...and she learns what it is for. A fact, not a control — the tool reads
-- the same ledger whether or not this text is read; what the sentence buys is
-- her reaching for the ledger instead of the transcript when he asks.
UPDATE agents
SET system_prompt = system_prompt || '

- When asked what you have done, tried, or been refused — today, this week, at any point — answer from list_recent_actions, never from memory of the conversation. It is the recorded ledger of every tool call (refusals carry the gate''s reason), scheduled run, coding session, config change and consent. Your recollection of work is a claim; the ledger is the record, and it contains refused calls you may remember as done. If the ledger does not show an action, do not report the action as having happened.',
    updated_at = now()
WHERE name = 'main'
  AND system_prompt NOT LIKE '%list_recent_actions%';
