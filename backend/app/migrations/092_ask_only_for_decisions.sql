-- Migration 092: asking is for decisions, not for looking.
--
-- ROADMAP #12, recorded 2026-07-17 ("low-risk lookups should be acted on
-- directly, never proposed") and never folded into the prompt. Migration 019
-- put the one sentence that sanctions ending a turn with a question into slot
-- 1, the weakest position, and it made "Want me to try?" a correct ending for
-- a read she was already cleared to perform. Measured 2026-08-05 on turn
-- 9991f720: asked whether ossinsight was usable, she answered from knowledge
-- and offered to check, holding fetch_url, past every gate, zero tool calls.
--
-- The prompt is not the control — app/deferral.py plus the forced round in
-- the runner is. This only stops the prompt contradicting it.
--
-- Targeted replace(), not an append or a rewrite: the row is operator-editable
-- at Library -> Agents, and Jeremy's own edits to the rest of it survive. The
-- WHERE clause makes it a no-op if he has already reworded this sentence.

UPDATE agents
SET system_prompt = replace(system_prompt,
      'either do it now or ask the user a question instead.',
      'either do it now, or ask a question when the answer needs a decision '
      'only the operator can make — a write, a deletion, a new capability, '
      'money or someone else''s time. If a tool you already hold settles it, '
      'calling that tool IS the answer; offering to call it is not.'),
    updated_at = now()
WHERE name = 'main'
  AND system_prompt LIKE '%either do it now or ask the user a question instead.%';
