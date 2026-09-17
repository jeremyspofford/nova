-- S15 — a message the owner sent while a turn was running.
--
-- Two defects, one table. The composer was dead while Nova worked, so a
-- correction typed during a twenty-minute model pull had nowhere to go. And
-- nothing server-side stopped a second POST: it opened a SECOND turn against
-- the same conversation, neither turn saw the other's message, and two replies
-- landed interleaved.
--
-- A row here is a message core ACCEPTED and owes an answer for. It is in
-- exactly one of three states, and which one is derived from the columns
-- rather than stored as a word anyone has to keep in step:
--
--   waiting   claimed_at IS NULL AND cancelled_at IS NULL
--   claimed   claimed_at IS NOT NULL  (turn_id names the turn that ran it)
--   cancelled cancelled_at IS NOT NULL (cancelled_reason always says why)
--
-- `seq` exists because `created_at` ties: two messages queued inside one
-- transaction share its timestamp, and a random uuid is no tiebreaker, so
-- "the oldest waiting one" would be ambiguous in exactly the case that matters
-- (a burst of typing). Order is (seq), always.

CREATE TABLE queued_messages (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Monotonic within the table: the only total order the drain trusts.
    seq               bigserial NOT NULL,
    conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    -- Whose message it is. CASCADE, unlike turns.person_id: a turn is a
    -- spending record that must survive the person, an unsent message is not.
    person_id         uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    body              text NOT NULL CHECK (btrim(body) <> ''),
    created_at        timestamptz NOT NULL DEFAULT now(),
    claimed_at        timestamptz,
    -- The turn that ran it. SET NULL rather than CASCADE: losing the turn must
    -- not erase the record that the message was accepted and sent.
    turn_id           uuid REFERENCES turns(id) ON DELETE SET NULL,
    cancelled_at      timestamptz,
    cancelled_reason  text,

    -- A claim exists only with the turn it claimed it for, and vice versa, so
    -- a crash between the two cannot leave a row that reads as sent but names
    -- nothing. (Both happen in one transaction; this is what enforces it.)
    CONSTRAINT queued_messages_claim_names_its_turn
        CHECK ((claimed_at IS NULL) = (turn_id IS NULL)),
    -- Claimed and cancelled are mutually exclusive: a message either ran or it
    -- did not, and "both" would make the drain's own records unreadable.
    CONSTRAINT queued_messages_ran_or_did_not
        CHECK (NOT (claimed_at IS NOT NULL AND cancelled_at IS NOT NULL)),
    -- Every cancellation states its reason. A row that simply stops being
    -- waiting, with nothing saying why, is a message silently dropped after
    -- core answered 202 — the defect this whole table exists to not have.
    CONSTRAINT queued_messages_cancellation_says_why
        CHECK ((cancelled_at IS NULL) = (cancelled_reason IS NULL))
);

-- The drain's one query: the oldest waiting row for a conversation.
CREATE INDEX queued_messages_waiting
    ON queued_messages (conversation_id, seq)
    WHERE claimed_at IS NULL AND cancelled_at IS NULL;
