-- S22: the index the throughput reads need.
--
-- app/model_speed.py answers "how fast is this model going, and how fast is
-- it usually" by scanning `llm_call` spans over a time window — two hours
-- for recent, thirty days for the baseline. Both run on every beat (the
-- `inference_degraded` check) and on every `inference_health` call.
--
-- Without an index that is a sequential scan of every span ever filed, and
-- it gets slower every month the machine runs. `turn_spans_turn` is on
-- (turn_id, started_at), which answers "this turn's spans" and nothing
-- about a window across turns.
--
-- Partial on kind = 'llm_call' deliberately: tool and guard spans are the
-- overwhelming majority of the table and no query here ever wants them, so
-- the index stays a fraction of the size a full one would be.

CREATE INDEX IF NOT EXISTS turn_spans_llm_call_started
    ON turn_spans (started_at DESC)
    WHERE kind = 'llm_call';
