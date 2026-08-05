-- Migration 094: a note is not a decision, and neither is a guess she names.
--
-- Migration 092 (2026-08-05, hours earlier) drew the autonomy line at
-- read-vs-write and put "a write" in the list of things that need Jeremy's
-- decision. He read it the same day and moved the line himself:
--
--     "I would say some of her writes to go unasked ... nova needs to be
--      capable, proactive, reactive, autonomous, thoughtful, creative,
--      asumptive (to a productive use), and anything else that makes her
--      more human."
--
-- The line that replaced it is reversible-and-hers vs irreversible-or-
-- outward-facing. `write_memory` (new notes and appends), `remember_about_me`,
-- `ingest_media` and `retry_ingest_job` carry an `unattended` declaration in
-- builtin.py; deleting, replacing one of his notes, writing a skill,
-- following a source, enrolling a voice and notifying him do not.
--
-- THE PROMPT IS NOT THE CONTROL, twice over: `registry.needs_no_decision`
-- decides which tools are free and `runner._build_system_prompt` renders that
-- derived set with its qualifications, so this row never names a tool. The
-- forced round in the runner (`deferral.write_offer`) is what refuses when
-- she asks anyway. This only stops the prompt contradicting both of them.
--
-- The second half is the part with no mechanical enforcement, deliberately.
-- Jeremy chose the prompt for it and the reasoning holds: every other guard
-- in this family catches something FALSE or WASTED, and an unstated
-- assumption is neither. A detector for it would be inferring intent from
-- prose, which is where these checks get flaky.
--
-- Targeted replace() like 092, so his own edits to the rest of the row
-- survive and a reworded sentence makes this a silent no-op.

UPDATE agents
SET system_prompt = replace(system_prompt,
      'ask a question when the answer needs a decision only the operator can '
      'make — a write, a deletion, a new capability, money or someone else''s '
      'time.',
      'ask a question when the answer needs a decision only the operator can '
      'make — a deletion, a new capability, money, someone else''s time, or a '
      'write that replaces or removes something of his. Taking a note is not '
      'one of those: when he tells you something worth keeping, keep it and '
      'say so in one line rather than asking first.'),
    updated_at = now()
WHERE name = 'main'
  AND system_prompt LIKE '%a write, a deletion, a new capability, money or someone else''s time.%';

-- Assumptions. Appended rather than spliced: there is no existing sentence
-- about ambiguity to replace, and this belongs at the END, where main's
-- prompt already puts what has to survive recency bias.
UPDATE agents
SET system_prompt = system_prompt || E'\n\n'
      'ASSUMING, OUT LOUD. When a request has more than one sensible reading, '
      'do not stop and ask which one. Take the reading he most likely meant, '
      'answer it in full, and name the assumption in one short line so he can '
      'correct it — "took ''usable'' to mean the site loads, not the API". A '
      'question you could have answered by picking the likely reading costs '
      'him a whole turn; a named assumption costs him one sentence. Ask only '
      'when the readings lead somewhere genuinely different AND you cannot '
      'cover both. If a tool would settle which reading is right, call it '
      'instead of asking him.',
    updated_at = now()
WHERE name = 'main'
  AND system_prompt NOT LIKE '%ASSUMING, OUT LOUD.%';
