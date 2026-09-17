-- S18 scripted skills: a skill that RUNS, instead of a procedure she follows.
--
-- An S17 skill is procedure text. She reads it and then makes every call
-- herself, one model round per step, each carrying the whole context, with the
-- order of the steps left to a model that has just been told the order. A
-- SCRIPT is that same procedure as a list of steps the runner dispatches
-- through the same tool registry her own calls go through.
--
-- WHY THE SCRIPT IS NOT A SHELL SCRIPT, since that is the obvious shape and
-- was considered: every honesty control in v4 reads turn_spans — the narration
-- guard, the capability verifier, the S17 ledger — and a shell script produces
-- ONE span holding stdout, with the per-step record gone. Steps here go
-- through tools.dispatch and each files its own span under the REAL tool's
-- name, so every reader keeps working without being told scripts exist.
--
-- jsonb, not a table of step rows: a script is edited, validated and run as a
-- WHOLE (a half-valid script is not a thing anyone wants stored), and the
-- validator refuses the document rather than the row.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS script jsonb;

-- The JSON Schema for what run_skill must be handed. NULL only when there is
-- no script: a script that takes nothing carries an empty-properties schema,
-- because "takes nothing" and "nobody said" are different facts, and the
-- second one would validate anything.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS inputs jsonb;

ALTER TABLE skills ADD CONSTRAINT skills_script_and_inputs_together
    CHECK ((script IS NULL) = (inputs IS NULL));
