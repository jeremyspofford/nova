-- What Nova can do changed — and she had no way to know.
--
-- The platform-state block tells her what exists RIGHT NOW and explicitly
-- says "anything not on it does not exist". That is state, never change:
-- she cannot notice that an agent was disabled, that a tool was revoked, or
-- that a skill appeared, so she cannot mention it, cannot explain a
-- capability she lost, and cannot fix a misconfiguration she did not
-- already know about. The operator asked for exactly this: "when nova gains
-- or loses tools or agents, or if an agent gains or loses a tool/skill,
-- that should surface to nova. she should know that."
--
-- An EVENT LOG rather than a diff, for two reasons that are not obvious:
--   * losses are the half that matters, and a deleted row leaves nothing to
--     compare against
--   * agents and tools carry updated_at, but it cannot say WHAT changed — a
--     description edit and a revoked tool grant look identical
--
-- It doubles as the audit trail for who changed what, which did not exist.
CREATE TABLE IF NOT EXISTS capability_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    at          timestamptz NOT NULL DEFAULT now(),
    -- what kind of thing: agent | tool | skill | mcp_server
    kind        text NOT NULL,
    -- its name, as a human would say it
    subject     text NOT NULL,
    -- created | updated | enabled | disabled | deleted | granted | revoked
    action      text NOT NULL,
    -- 'operator' for the Settings UI, otherwise the agent that did it.
    -- Attribution matters: "you disabled coder" and "agent-manager disabled
    -- coder" call for different responses.
    actor       text NOT NULL DEFAULT 'operator',
    -- the interesting delta only — never the whole row, and never a system
    -- prompt (long, and it would put prompt text into a block that is read
    -- back into a prompt)
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- the only query shapes: newest-first overall, and newest-first per subject
CREATE INDEX IF NOT EXISTS capability_events_at_idx
    ON capability_events (at DESC);
CREATE INDEX IF NOT EXISTS capability_events_subject_idx
    ON capability_events (subject, at DESC);
