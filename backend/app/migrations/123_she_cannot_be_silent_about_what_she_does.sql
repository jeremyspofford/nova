-- Migration 123: she cannot be silent about what she does.
--
-- Jeremy, 2026-08-07: "I also need a logging way to actually see what she's
-- doing. Activity page doesn't help me at all and the observability page
-- doesn't help me on what's she's doing either. She cannot be silent on her
-- actions. We lack logging."
--
-- `app/activity_log.py` is the answer, and it is a READ MODEL: it owns no
-- table and has no write path, because a second audit log is a log that
-- drifts from the system it claims to describe. Every row it renders is
-- derived from records something else already writes.
--
-- SO THIS MIGRATION ADDS ONLY INDEXES — one per query shape the read model
-- actually issues, and not one more. An index nothing queries is a write
-- cost with no reader.
--
-- The one that matters is the first. `turn_spans` has carried exactly one
-- index since migration 028 — `(trace_id, seq)` — because until now the only
-- way anyone read a span was "give me this ONE trace's spans" from the Turn
-- Inspector. The action log asks the opposite question, "give me the newest
-- tool calls across every trace", and on this install that is a sequential
-- scan of ~10,000 rows to return 120. It is also the query behind every
-- refusal count on the page, so it runs on each poll.
--
-- PARTIAL, on kind='tool', for two reasons: tool spans are a quarter of the
-- table (llm_call and stage are the bulk, and neither is an ACTION), and a
-- partial index keeps `kind` out of the key while still serving the ORDER BY
-- started_at DESC that the page is built on.
--
-- CREATE INDEX, not CONCURRENTLY: db.run_migrations wraps each migration body
-- in one transaction with its ledger row, and CONCURRENTLY cannot run inside
-- a transaction block. These tables are thousands of rows, not millions.

CREATE INDEX IF NOT EXISTS turn_spans_tool_recent_idx
    ON turn_spans (started_at DESC)
    WHERE kind = 'tool';

COMMENT ON INDEX turn_spans_tool_recent_idx IS
    'Newest tool calls across all traces — the action log''s spine. The '
    'existing (trace_id, seq) index answers the opposite question.';

-- automation_runs is indexed per-automation (migration 025), which is right
-- for "this job''s history" and useless for "everything that ran today".
CREATE INDEX IF NOT EXISTS automation_runs_recent_idx
    ON automation_runs (started_at DESC);

-- action_runs has a partial index on queued work only (migration 088). The
-- log wants the finished ones too — those are the rows that say whether an
-- approval he clicked actually did anything.
CREATE INDEX IF NOT EXISTS action_runs_recent_idx
    ON action_runs (created_at DESC);

-- consents is indexed by (conversation_id, status, created_at) — no use to a
-- global chronological read. Ordered by the DECISION where there is one, so a
-- consent raised on Monday and approved on Wednesday lands on Wednesday,
-- which is when the operator did the thing.
CREATE INDEX IF NOT EXISTS consents_recent_idx
    ON consents ((COALESCE(decided_at, created_at)) DESC);

-- coding_sessions is indexed on created_at (migration 079). The log orders by
-- the PROGRESS clock migration 121 added, because a session that started an
-- hour ago and moved a minute ago belongs next to the minute-ago rows — that
-- is the whole point of a chronological log of what is happening.
CREATE INDEX IF NOT EXISTS coding_sessions_progress_idx
    ON coding_sessions ((COALESCE(progress_at, updated_at, created_at)) DESC);

-- capability_events (at DESC, migration 057) and ingest_jobs
-- (COALESCE(finished_at, started_at, enqueued_at) DESC, migration 041) are
-- ALREADY indexed for exactly the shapes the read model uses. Deliberately
-- not duplicated here.
--
-- NO GRANT IN THIS MIGRATION, and that is a statement rather than an
-- oversight — the repo's rule is that a tool is not a capability until an
-- agent holds it, so the absence has to be explained. This lane adds an
-- OPERATOR surface and no tool: nothing new is callable, so there is nothing
-- to grant. The tool this log makes obvious — `list_recent_actions`, so she
-- can answer "what have you actually done today?" from the ledger instead of
-- from the transcript, and so the capability-claim verifier could check a
-- claimed action against it — needs `app/tools/builtin.py` and
-- `agents/registry.py`, both outside this lane's files. It is written up as a
-- follow-up rather than half-built here.
