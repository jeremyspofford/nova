-- S28 — a file he gave her in the conversation.
--
-- The FILE lives in the workspace (attachments/<conversation>/<name>), which
-- is the volume she already has read/write/list/delete tools over. This table
-- is the record of what arrived and where it went, never a second copy of the
-- bytes: she reads the file with the same tools she reads any other file
-- with, so the read lands on the trace instead of being asserted.
--
-- An attachment exists BEFORE the message that carries it. He picks a file,
-- then types, then sends — so the upload writes a row with a conversation and
-- no message, and sending binds it. A row that never gets bound is an upload
-- he abandoned; it keeps its conversation so it can be swept, and so the
-- volume cannot fill with files belonging to nothing.
CREATE TABLE attachments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    -- Bound when the message is sent. NULL means uploaded and not yet sent.
    -- ON DELETE CASCADE with the message: a conversation someone deleted does
    -- not leave rows pointing at files inside it.
    message_id      uuid REFERENCES messages (id) ON DELETE CASCADE,
    -- WHO gave it to her. A file is his, not the household's.
    person_id       uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    -- The name he chose, as he typed it, for showing back to him.
    filename        text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
    -- What the bytes ARE, sniffed from the bytes rather than trusted from the
    -- upload: a browser's declared type is a claim by whatever made the
    -- request, and the model routing below depends on this being right.
    media_type      text NOT NULL,
    size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
    -- Where it landed, RELATIVE to the workspace root — the same string her
    -- workspace tools take, so "read the file he sent" needs no translation
    -- and no second notion of where things are.
    path            text NOT NULL,
    -- The extracted text, for kinds that have any (PDF today). NULL means
    -- either "nothing to extract" or "not that kind"; `extract_note` says
    -- which, because a PDF that yielded nothing and a PDF nobody tried to
    -- read are different facts and only one of them is a scanned document.
    extracted_text  text,
    extract_note    text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- The two reads this table gets: everything on one message (rendering a
-- conversation) and everything still unbound in a conversation (binding them
-- at send, and sweeping what was abandoned).
CREATE INDEX attachments_by_message ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_unbound ON attachments (conversation_id, created_at)
    WHERE message_id IS NULL;
