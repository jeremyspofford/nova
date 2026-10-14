-- S37c (she reacts): the programs that may start a turn of hers, and every call
-- they made (docs/plans/rebuild/s37c/spec.md §2.1, §2.2, §3).
--
-- event_senders: one row per sender. A `token` sender is another program; it
-- holds a token whose sha256 is kept here (identity.hash_token, as sessions do),
-- never the token itself. `token_once` is the one exception: a sender Nova adds
-- (event_sender_add) keeps its plaintext until the owner's Settings page reveals
-- it once, which nulls it, so the token reaches his screen and never her
-- context. The built-ins (`monitor`, kind monitor; `github_ci`, kind poll) are
-- core's own and hold no token: the intake refuses them. They are seeded by code
-- at startup (events.ensure_builtins), never here — the tests TRUNCATE.
--
-- The name is also the role's suffix: `event_<name>` must pass the gateway's
-- ROLE_RE ^[a-z_]{1,32}$, so the name is ^[a-z][a-z_]{0,25}$ and the role is
-- pinned to it by a CHECK.
--
-- events: one row per call to the intake, accepted or refused (with its
-- reason), and per event core files itself. `sender` is a word, not a foreign
-- key: a refused call from an unknown sender keeps the name it used, and a
-- deleted sender's history stays. `turn_id` names the turn that read it.
--
-- Number: main ends at 049_tool_results; S32.3 (unmerged) holds 050_landings.
--
-- Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS event_senders (
    name         text PRIMARY KEY CHECK (name ~ '^[a-z][a-z_]{0,25}$'),
    kind         text NOT NULL CHECK (kind IN ('token', 'monitor', 'poll')),
    token_hash   text,
    token_once   text,
    role         text NOT NULL,
    enabled      boolean NOT NULL DEFAULT true,
    last_sent_at timestamptz,
    -- Who added it: 'owner', 'nova' or 'builtin'. A word, like mcp_servers.
    added_by     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_senders_role CHECK (role = 'event_' || name),
    CONSTRAINT event_senders_token CHECK ((kind = 'token') = (token_hash IS NOT NULL)),
    CONSTRAINT event_senders_token_once CHECK (token_once IS NULL OR kind = 'token')
);

CREATE TABLE IF NOT EXISTS events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender       text NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    payload      text,
    content_type text,
    state        text NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'done', 'failed', 'refused')),
    reason       text,
    turn_id      uuid REFERENCES turns (id) ON DELETE SET NULL,
    fingerprint  text,
    urgent       boolean NOT NULL DEFAULT false,
    CONSTRAINT events_refused_reason CHECK (state <> 'refused' OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS events_sender_state ON events (sender, state, received_at);
CREATE INDEX IF NOT EXISTS events_received ON events (received_at DESC);
