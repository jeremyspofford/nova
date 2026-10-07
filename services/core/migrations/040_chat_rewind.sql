-- Chat rewind (chat-rewind epic, T1): the action ledger and the rewind record.
--
-- turn_actions: one row per call of a tool that CHANGES something (not
-- reads_only) whose executor was reached, written by traces.close_turn in the
-- same transaction as the turn's spans — a turn that never closed has neither.
-- `undo` is what the executor said it would take to put back what it changed
-- (NULL: it said nothing, so nothing can ever be claimed reverted).
--
-- rewinds: one row per rewind the owner asked for. Messages after the target
-- are withdrawn (messages.withdrawn_by), never deleted: threads, attachments
-- and notices hang off message rows. The marker the next turn reads is a
-- messages row carrying rewind_id. messages gains no `kind` column (017
-- dropped it; test_no_approvals pins that).
--
-- The id columns are nullable with SET NULL / CASCADE so deleting a
-- conversation, a person or a message never strands a row or blocks the delete.

CREATE TABLE IF NOT EXISTS rewinds (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   uuid REFERENCES conversations (id) ON DELETE CASCADE,
    person_id         uuid REFERENCES people (id) ON DELETE SET NULL,
    target_message_id uuid REFERENCES messages (id) ON DELETE SET NULL,
    mode              text NOT NULL CHECK (mode IN ('chat', 'executions')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    undone            jsonb NOT NULL DEFAULT '[]',
    not_undone        jsonb NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS rewinds_conversation ON rewinds (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS turn_actions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id         uuid NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
    seq             integer NOT NULL,
    tool            text NOT NULL,
    ok              boolean NOT NULL,
    undo            jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    reverted_by     uuid REFERENCES rewinds (id) ON DELETE SET NULL,
    revert_ok       boolean,
    revert_result   text,
    UNIQUE (turn_id, seq)
);

CREATE INDEX IF NOT EXISTS turn_actions_conversation ON turn_actions (conversation_id, created_at);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS withdrawn_by uuid
    REFERENCES rewinds (id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS rewind_id uuid
    REFERENCES rewinds (id) ON DELETE CASCADE;
