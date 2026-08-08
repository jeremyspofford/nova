-- Migration 122: a degrading model does not pass as a reply.
--
-- THE FAILURE, measured in this database on 2026-08-07 between 20:45 and
-- 21:31 with `main` bound to openrouter:~deepseek/deepseek-v4-flash-latest:
--
--   21:30:41  asked "Are you doing that eval auto recovery task?", she
--             replied literally `8`. The llm_call span for that round:
--             completion_chars 1, completion_tokens 2, prompt_tokens 32531,
--             tool_calls_requested 0 — and status `ok`. Two earlier rounds
--             had already been retracted by the forged-receipt and narration
--             guards; the third produced one character and the loop took it
--             as the finished answer.
--   20:52:36  a 475-character reply whose first 114 alphabetic characters
--             were CJK pseudo-system text listing her own tools and telling
--             her not to fake calls. Nothing in Nova wrote that, and the
--             conversation is entirely English.
--   20:45:29  "trainerPULL the qwen3:30b-a3b model onto this box now.I don't
--             have an active goal…" — the operator's own message, verbatim,
--             glued into the reply with no delimiter on either side.
--
-- EVERY ONE OF THOSE TURNS RETURNED status=ok. That is the whole defect.
-- `model_chain` derives a cross-tier standby and `llm/router.py` fails over
-- on ERRORS; a model returning garbage is not an error, so failover never
-- fired and a goal Jeremy had approved could not complete because junk was
-- accepted as a finished answer.
--
-- The code half of this lane (app/degeneracy.py) measures three mechanical
-- signals on the completion — near-empty with nothing done, the person's own
-- message handed back, and a writing system that appears nowhere in the
-- input — and reports a hit as a FAILURE through the existing
-- `_fallback_target` path, so the retry reuses model_chain and the router
-- rather than growing a second failover. One retry per turn; if the standby
-- degenerates too, the turn fails visibly instead of emitting the junk.
--
-- This table is the measurement. Without it "the model is having a bad day"
-- stays anecdotal, which is how a model that produced eight detector hits in
-- two hours kept the front door.
--
-- NO NEW TOOL, THEREFORE NO NEW GRANT. Stated explicitly because the missing
-- grant is this repo's most repeated omission (095, 096, 099, 104, 106): the
-- rows written here reach the operator through paths agents already hold —
-- model_fitness.assess (Settings -> Models fitness panel, and the standby
-- fitness gate in runner._fit_for) and a recommendation card raised by the
-- backend itself. No agent's allowed_tools changes, so the pinned grant
-- snapshots (test_eval_grants, test_eval_servability, granted.json) must NOT
-- move for this migration. If one does, something else changed.

CREATE TABLE IF NOT EXISTS model_health (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- the RESOLVED model id (post effective_model), because that is what
    -- actually ran; the agent's binding may name something else entirely
    model       TEXT NOT NULL,
    -- which agent's turn it was. Nullable: a signal is a fact about the
    -- model whether or not the agent could be named.
    agent_name  TEXT,
    -- one of degeneracy.NEAR_EMPTY / ECHO / FOREIGN_SCRIPT. Deliberately not
    -- a CHECK constraint or an enum: a new signal is a code change in one
    -- file, and a constraint here would make it a migration too.
    signal      TEXT NOT NULL,
    -- the scrubbed, bounded evidence — "the whole reply was '8' (1
    -- character) and no tool ran this turn". A count with no evidence is
    -- unfalsifiable, which is the shape of gauge an operator stops reading.
    detail      TEXT,
    -- the turn ledger row, so a health record leads to the trace that proves
    -- it. A reply is a claim; turn_spans is the fact.
    trace_id    UUID,
    -- what the round was retried on, or NULL when nothing could take it.
    -- This is the difference between "she recovered" and "the turn died".
    standby     TEXT
);

-- The reader's query, both of them: "what has this model done lately"
-- (fitness findings, the card threshold) and "what has degraded at all"
-- (the operator scanning).
CREATE INDEX IF NOT EXISTS model_health_model_at_idx
    ON model_health (model, recorded_at DESC);
CREATE INDEX IF NOT EXISTS model_health_at_idx
    ON model_health (recorded_at DESC);
