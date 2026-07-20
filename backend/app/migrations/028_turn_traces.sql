-- Migration 028: turn ledger — traces + spans
-- (docs/plans/observability-turn-tracing.md, phase 1)
--
-- One trace per agent turn, spans for every stage/LLM call/tool/dispatch
-- inside it. Diagnostics, not memory: nothing else may depend on these
-- rows, and retention pruning (phase 3) deletes them freely.

CREATE TABLE IF NOT EXISTS turn_traces (
    id              UUID PRIMARY KEY,
    source          TEXT NOT NULL DEFAULT 'chat'
                    CHECK (source IN ('chat', 'automation', 'compaction')),
    automation      TEXT,             -- automation name when source='automation'
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    model           TEXT,             -- effective model for the turn's main call
    status          TEXT NOT NULL DEFAULT 'ok'
                    CHECK (status IN ('ok', 'error', 'cancelled')),
    error           TEXT,
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS turn_traces_started_idx
    ON turn_traces (started_at DESC);
CREATE INDEX IF NOT EXISTS turn_traces_conversation_idx
    ON turn_traces (conversation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turn_spans (
    id             UUID PRIMARY KEY,
    trace_id       UUID NOT NULL REFERENCES turn_traces(id) ON DELETE CASCADE,
    parent_span_id UUID,              -- null = top level; dispatch subtrees nest
    seq            INT NOT NULL,      -- creation order within the trace
    kind           TEXT NOT NULL
                   CHECK (kind IN ('stage', 'llm_call', 'tool', 'dispatch')),
    name           TEXT NOT NULL,     -- stage name, model, tool name, agent name
    status         TEXT NOT NULL DEFAULT 'ok'
                   CHECK (status IN ('ok', 'error', 'cancelled')),
    started_at     TIMESTAMPTZ NOT NULL,
    finished_at    TIMESTAMPTZ,
    detail         JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS turn_spans_trace_idx
    ON turn_spans (trace_id, seq);
