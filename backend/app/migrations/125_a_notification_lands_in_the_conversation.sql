-- Migration 125: a notification lands in the conversation
--
-- Jeremy, 2026-08-07, verbatim: "I get push notifications from the PWA but
-- when I click on it, it brings me to chat but doesn't show me what the push
-- notification was. Notifications should be in chat, not just the
-- notifications bell."
--
-- Two separate failures behind that one sentence:
--
--   1. A notification had no record anywhere the transcript could show. It
--      was an httpx POST and a log line; nothing in the database said one had
--      ever been raised, so "show me what it was" had no row to read.
--   2. The tap threw away WHICH notification was tapped. The service worker
--      focused whatever window existed and, when `navigate` was unavailable
--      (iOS standalone PWAs among them), that was the whole of it — the app
--      came up on chat with nothing on screen about the thing he tapped.
--
-- So: `notifications` is the ONE record a push is generated from, and the
-- transcript row is a POINTER at it, not a copy. The CHECK below is what
-- makes that true rather than intended — a role='notification' message may
-- not carry its own content, so there is no second copy of the text that can
-- drift from the one the push was built from.
--
-- HONEST DELIVERY (docs: operator-visible-outcomes). There is deliberately no
-- 'delivered' state and no boolean by that name. A transport can only ever
-- move a row to 'accepted' — the relay took it — and only a client that
-- actually rendered the thing can move it to 'opened'. Nothing in
-- app/notifications.py writes 'opened' from a provider response; the only
-- writer is the authenticated open endpoint the chat panel calls when it has
-- put the item on screen.

CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- where it landed in the transcript. NULL is legal and means it did not:
    -- notify.send records the notification either way, and `record()` returns
    -- the reason it could not be placed rather than swallowing it.
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,

    kind            TEXT NOT NULL DEFAULT 'alert',
    source          TEXT,
    title           TEXT,
    body            TEXT NOT NULL,
    -- what the CALLER wanted a tap to open (an inbox, an observability page).
    -- The push's own click URL is the deep link to THIS row; this rides along
    -- so the chat item can still offer the caller's destination as a link.
    click_url       TEXT,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    priority        TEXT,

    -- the inbox card this notification is about, when there is one. Opening
    -- the chat item marks that card seen, which is what stops one piece of
    -- news demanding attention in two places forever.
    recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,

    -- anti-nag, derived from the content (app/notifications.py fingerprint),
    -- never from a maintained list of "things that repeat".
    fingerprint     TEXT NOT NULL,
    repeats         INT  NOT NULL DEFAULT 0,
    last_repeat_at  TIMESTAMPTZ,

    state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'accepted', 'failed', 'opened')),
    provider        TEXT,
    transport_id    TEXT,
    accepted_at     TIMESTAMPTZ,
    error           TEXT,
    opened_at       TIMESTAMPTZ,
    opened_via      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A state that claims something must carry the evidence for it. These are
    -- the lines that refuse: a row cannot say a relay accepted it without the
    -- moment, cannot say a device opened it without the moment, and — the one
    -- that matters most here — cannot say it failed without saying why. A
    -- failure with an empty reason is the "fallback that reads as success"
    -- this repo keeps rediscovering.
    CONSTRAINT notifications_accepted_has_time
        CHECK (state <> 'accepted' OR accepted_at IS NOT NULL),
    CONSTRAINT notifications_opened_has_time
        CHECK (state <> 'opened' OR opened_at IS NOT NULL),
    CONSTRAINT notifications_failed_has_reason
        CHECK (state <> 'failed'
               OR (error IS NOT NULL AND length(btrim(error)) > 0))
);

CREATE INDEX IF NOT EXISTS notifications_recent_idx
    ON notifications (created_at DESC);

-- the dedupe lookup: "has this exact news already gone out, recently?"
CREATE INDEX IF NOT EXISTS notifications_fingerprint_idx
    ON notifications (fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recommendation_idx
    ON notifications (recommendation_id)
    WHERE recommendation_id IS NOT NULL;

COMMENT ON COLUMN notifications.state IS
    'pending -> accepted (a relay took it) -> opened (a client rendered it). '
    'There is no "delivered": acceptance by a transport is not receipt by a '
    'person, and nothing but the authenticated open endpoint may write '
    '"opened".';


-- ── the transcript row is a pointer, not a copy ──────────────────────────

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check
    CHECK (role IN ('user', 'assistant', 'tool', 'notification'));

-- THE REFUSAL. "It must be the SAME record the push was generated from, not a
-- second copy that can drift; derive one from the other." A copy is only
-- prevented if writing one fails, so writing one fails: a notification row in
-- the transcript has no content of its own and must name the notification it
-- renders.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_notification_is_a_pointer;
ALTER TABLE messages ADD CONSTRAINT messages_notification_is_a_pointer
    CHECK (role <> 'notification'
           OR (content IS NULL AND metadata ? 'notification_id'));

CREATE INDEX IF NOT EXISTS messages_notification_idx
    ON messages ((metadata->>'notification_id'))
    WHERE role = 'notification';


-- ── grants ───────────────────────────────────────────────────────────────
--
-- No new tool ships in this lane, so there is nothing here to grant. The
-- capability an agent gains is inside a tool she already holds:
-- `_notify_operator` in app/tools/builtin.py now relays notify.send's
-- `notification_id`, `in_chat` and `delivery_label` (the row's own honest
-- line) instead of only the transport's id, so she can say "it was accepted
-- by webpush and has not been opened" instead of "I notified you" — and a
-- call that published nothing because the news was already raised comes back
-- as status 'deduped', never 'accepted'.
--
-- WHAT IS STILL MISSING, stated because the earlier draft of this comment
-- described the paragraph above as done while builtin.py was untouched, and
-- the next reader believed it: there is no READ tool over this table. She can
-- report the state of a notification in the turn she sends it and no later.
-- `notification_status(notification_id)` is the obvious next step; it is a
-- new tool, so it also needs a grant here and a deliberate bump of the pinned
-- eval snapshots (test_eval_grants, test_eval_servability, reads_only).
