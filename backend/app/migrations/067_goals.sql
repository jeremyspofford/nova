-- Goal-scoped autonomy. Jeremy, 2026-07-28 21:14:
--
--   "maybe research & knowledge should always be allowed, while everything
--    else requires approval with the option to auto-approve. we could
--    auto-approve a 'goal' so you could actually do 2-6 as well as you'd be
--    auto-approved ahead of time - but only for the goal"
--
-- A goal is therefore a CONSENT WITH A SCOPE AND A LIFETIME. The existing
-- `consents` row is single-use and names one operation; this names a set of
-- verbs and stays spendable until it expires, runs out of actions, or is
-- closed. Same principle underneath: validated mechanically, never by LLM
-- judgment.
--
-- The design question that decides whether this is a control or a decoration
-- is "what does 'only for the goal' MEAN to code?" It cannot mean "the model
-- believes this action serves the goal" — that is a prompt, and a prompt is a
-- request. So scope is carried as an explicit list of VERBS the operator
-- ticked when approving, and the check is a set membership test. A goal to
-- "manage my router" that was approved for tool creation cannot pull a model,
-- however sincerely an agent argues the connection.
--
-- The caps are the throttle Jeremy expected costs to provide: `max_actions`
-- bounds how much can be spent before he is asked again, and `expires_at`
-- bounds how long a forgotten goal stays live. Concurrent goals are allowed
-- deliberately — he asked for them, and these two caps are what make the
-- concurrency safe rather than a count limit that would need tuning.

CREATE TABLE IF NOT EXISTS goals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title           text NOT NULL,
    -- The declared, checkable finish line. Jeremy: "a set deterministic
    -- target that'll basically ensure it's completed when we hit a declared
    -- target." Stored as the operator's own words; closing the goal remains
    -- an explicit act, because a model deciding it has met its own target is
    -- the narration failure this codebase keeps building detectors for.
    target          text NOT NULL DEFAULT '',
    status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','active','paused','done','abandoned')),
    -- the verbs this goal pre-approves. NOT "everything" — see above.
    approved_verbs  text[] NOT NULL DEFAULT '{}',
    max_actions     integer NOT NULL DEFAULT 25,
    actions_used    integer NOT NULL DEFAULT 0,
    expires_at      timestamptz,
    proposed_by     text,
    rationale       text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    activated_at    timestamptz,
    closed_at       timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- the spend path filters on exactly this
CREATE INDEX IF NOT EXISTS goals_active_idx ON goals (status)
    WHERE status = 'active';

-- Outbound hosts an http_call tool may target.
--
-- The table already existed with TWO rows, both seeded by migration, and —
-- verified 2026-07-29 — no INSERT anywhere in the tree: no endpoint, no UI,
-- no agent tool. So "whitelist your router's API endpoint", which is what
-- Nova told Jeremy to do, was not something he could actually do without
-- hand-editing Postgres. That is the real reason "manage my router" has no
-- path today, and it is a missing operator surface rather than a missing
-- model capability.
--
-- Recording provenance so an allowlist entry can be traced back to the goal
-- that justified it, and removed with it.
ALTER TABLE tool_host_allowlist ADD COLUMN IF NOT EXISTS added_by text;
ALTER TABLE tool_host_allowlist ADD COLUMN IF NOT EXISTS goal_id uuid;
ALTER TABLE tool_host_allowlist ADD COLUMN IF NOT EXISTS added_at timestamptz DEFAULT now();
