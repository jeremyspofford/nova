-- S38b (reading past the context): every tool result she is sent, kept in
-- full for the life of its turn's trace (docs/plans/rebuild/s38b/spec.md §2.1).
--
-- The span keeps only the first SPAN_RESULT_HEAD_CHARS of a result. S38b
-- replaces old results with summaries in what is SENT, so the full text lives
-- here, and read_result serves it back. Written by traces.close_turn in the
-- same one transaction as the spans and the status: a turn whose trace landed
-- has its results, and a turn that never closed has neither.
--
-- `ref` is the turn's own handle for the result (r1, r2, ... in call order),
-- the one the summary marker names. Deleted with its turn (ON DELETE CASCADE,
-- as turn_spans); nothing else prunes it.
--
-- The next free number after 048_device_jobs; S32.3 takes 049_landings.
--
-- Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS tool_results (
    turn_id      uuid NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
    ref          text NOT NULL CHECK (ref ~ '^r[1-9][0-9]*$'),
    tool_call_id text,
    tool         text NOT NULL,
    content      text NOT NULL,
    -- The length of `content`, stated so a reader never fetches the text to
    -- size it; the CHECK keeps the two from disagreeing.
    chars        integer NOT NULL CHECK (chars = length(content)),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (turn_id, ref)
);
