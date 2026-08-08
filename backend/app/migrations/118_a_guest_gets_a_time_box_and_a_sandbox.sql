-- Migration 118: a guest gets a time box, a sandbox, and nothing else.
--
-- ROADMAP: docs/plans/public-access-and-guests.md, section 3.
--
-- Jeremy, 2026-08-07, asked verbatim for "chat + a sandbox memory that gets
-- wiped when I remove the guest access for that user (ie: delete user or
-- revoke whatever grant I've given them) + safe tools."
--
-- Three tables' worth of properties, one table plus one column:
--
-- 1. `guest_sessions` — a bearer credential that EXPIRES. The backend has had
--    exactly one static token since the beginning; publishing the origin makes
--    that token the whole wall, and "let a friend try the 9b model for an
--    afternoon" was previously spelled "give them admin forever".
--
--    The token itself is never stored. `token_hash` is sha256 of the raw
--    value, which is shown to the operator ONCE at mint and then exists
--    nowhere on this machine — same shape as the secrets store: a screenshot
--    of the guest list leaks nothing.
--
--    `expires_at` is NOT NULL with no default on purpose. A guest session
--    without an expiry is the thing this migration exists to prevent, so
--    there is no way to write one — the column refuses, rather than a caller
--    remembering to pass a value.
--
--    `allowed_models` is NOT NULL with a CHECK that it is non-empty. Jeremy's
--    sentence was "grant guest access over a small amount of time with
--    specific llms": a session that names no model is not a weaker version of
--    that, it is an unbounded one. Enforced in the column, then enforced
--    AGAIN in `runner.py` immediately before the request leaves — the prompt
--    is never the last line of defence, and neither is the schema.
--
--    `selected_model` is which of `allowed_models` the guest is currently on.
--    Server-side, so the choice cannot be made by a client that says so: the
--    endpoint that sets it refuses anything outside the array.
--
-- 2. `conversations.guest_id` — a guest's chat is THEIR chat.
--
--    `conversations.get_or_create_active_conversation()` is "newest row wins"
--    (conversations.py:13). Left alone, the first guest turn would insert a
--    row newer than the operator's and Jeremy's own chat would silently
--    switch to it — a guest session that captures the operator's chat is a
--    worse hole than the one this migration closes.
--
--    So a guest conversation is pinned to `-infinity` and CANNOT be the
--    newest row. Pinned by a TRIGGER rather than by the inserting code,
--    because the inserting code is the thing that would be wrong: the
--    property has to hold for any writer, including the next one.
--
--    ON DELETE CASCADE is the wipe's other half. Deleting the guest session
--    takes the conversation, and `messages.conversation_id` already cascades
--    from there, so "delete user" removes what they said as well as what they
--    remembered. The FILE side of the wipe (their memory namespace) is
--    `guests.wipe_memory`, which re-reads the directory afterwards and FAILS
--    if it is still there.
--
-- OPERATOR-ONLY BY CONSTRUCTION. There is deliberately no tool and no grant
-- in this migration. Minting a credential that reaches Nova is not something
-- Nova should be able to do for herself, and the routes that manage these
-- rows are absent from the guest-reachable allowlist in main.py, which is
-- default-deny — a route added tomorrow is guest-denied until someone marks
-- it otherwise.

CREATE TABLE IF NOT EXISTS guest_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- sha256 of the raw bearer token. The raw value is returned once, at
    -- mint, and never stored anywhere.
    token_hash      TEXT NOT NULL UNIQUE,
    label           TEXT NOT NULL,
    created_by      TEXT NOT NULL DEFAULT 'operator',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- no default: a session with no time box must be unwritable, not merely
    -- discouraged
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    last_seen       TIMESTAMPTZ,
    allowed_models  TEXT[] NOT NULL,
    selected_model  TEXT,
    CONSTRAINT guest_sessions_models_nonempty
        CHECK (array_length(allowed_models, 1) >= 1),
    -- a selection is only ever one of the allowed values; the API refuses
    -- first, and this refuses if the API is ever wrong
    CONSTRAINT guest_sessions_selected_is_allowed
        CHECK (selected_model IS NULL OR selected_model = ANY (allowed_models)),
    CONSTRAINT guest_sessions_expiry_after_creation
        CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS guest_sessions_live_idx
    ON guest_sessions (expires_at) WHERE revoked_at IS NULL;

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS guest_id UUID
        REFERENCES guest_sessions(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_guest_uniq
    ON conversations (guest_id) WHERE guest_id IS NOT NULL;

-- The pin. A guest conversation is stamped `-infinity` so that
-- `ORDER BY created_at DESC LIMIT 1` — the operator's active-conversation
-- query — can never return it while any operator conversation exists, and
-- `guests.conversation_for()` guarantees one exists before it inserts.
--
-- BEFORE INSERT OR UPDATE, so neither a fresh row nor a later re-stamping of
-- guest_id can escape it.
CREATE OR REPLACE FUNCTION nova_pin_guest_conversation()
RETURNS trigger AS $$
BEGIN
    IF NEW.guest_id IS NOT NULL THEN
        NEW.created_at := '-infinity'::timestamptz;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_pin_guest ON conversations;
CREATE TRIGGER conversations_pin_guest
    BEFORE INSERT OR UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION nova_pin_guest_conversation();

COMMENT ON COLUMN conversations.guest_id IS
    'Non-null = this chat belongs to a time-boxed guest session. Such rows are '
    'pinned to created_at = -infinity by the conversations_pin_guest trigger so '
    'the operator''s "newest row wins" active-conversation query can never '
    'return one. Cascades on guest deletion — that is half of the wipe.';

COMMENT ON COLUMN guest_sessions.allowed_models IS
    'The models this guest may run. Enforced in the column (non-empty), in the '
    'model-selection endpoint, and again in runner.py immediately before the '
    'request leaves — a guest asking for another model is a request, not a '
    'control.';
