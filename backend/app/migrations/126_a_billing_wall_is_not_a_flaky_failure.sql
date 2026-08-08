-- Migration 126: an action given back when the pass never ran.
--
-- MEASURED 2026-08-07. The self-improvement loop ran four passes unattended.
-- Every coding session failed with the same reply, and each pass retried it
-- three times before giving up:
--
--   the coding agent returned an error: {"code": -32603, "message": "Internal
--   error: API Error: 402 This request requires more credits, or fewer
--   max_tokens. You requested up to 32000 tokens, but can only afford 15846."}
--
-- Twelve coding sessions, four goal actions and four action_runs, all spent
-- against a wall that cannot clear itself by retrying. The classifier that
-- stops the retries is code (`app/provider_errors.py`); the part that needs
-- schema is giving the goal action BACK, because a budget the operator set to
-- bound unattended work must not be drained by a provider refusing to be paid.
--
-- WHY A TABLE AND NOT JUST A DECREMENT. A refund is the one operation in the
-- goal ledger that moves the counter the wrong way, so the only thing standing
-- between it and free credit is that it can happen exactly once per pass.
-- `run_id` is the primary key and `goals.refund_action` inserts ON CONFLICT DO
-- NOTHING inside the same transaction as the decrement: a re-run, a retry or
-- two workers racing cannot hand the same action back twice. It is also the
-- audit trail — every refund says which run, which lane and why.
--
-- NO NEW TOOL, so no new grant. Everything this lane adds is a refusal or a
-- correction inside machinery agents already hold (`delegate_coding_task`,
-- `check_coding_session`), and the classification reaches her through the
-- session shape those tools already return. The pinned grant suites are
-- expected to stay exactly where they are.

CREATE TABLE IF NOT EXISTS goal_action_refunds (
    -- ONE REFUND PER PASS, enforced here rather than remembered in code.
    run_id      uuid PRIMARY KEY REFERENCES action_runs(id) ON DELETE CASCADE,
    goal_id     uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    -- Which authority's pass this was ('goal' today). Recorded rather than
    -- assumed, so a future lane cannot be read as this one.
    lane        text NOT NULL DEFAULT 'goal',
    -- The provider's own account of the refusal, scrubbed. "Why is my budget
    -- back" has to be answerable from the row, not from a log that rotated.
    reason      text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goal_action_refunds_goal_idx
    ON goal_action_refunds (goal_id, created_at DESC);
