-- S24: a thread is a conversation that hangs off a message.
--
-- The whole point of this shape is that isolation is FREE. A turn's history
-- is `WHERE m.conversation_id = $1`; a thread IS a conversation, so its
-- history is already only its own messages. Nothing in prompt assembly has
-- to remember to filter — there is no filter to forget.

ALTER TABLE conversations
    ADD COLUMN parent_message_id uuid REFERENCES messages (id) ON DELETE CASCADE;

-- ONE room per message. The predicate is not decoration: postgres treats
-- NULLs as distinct, so a plain unique index would allow unlimited
-- threadless conversations (correct) and also allow nothing useful. This
-- gives exactly one room per message and leaves the hallway alone — a
-- double-tapped stub cannot fork a message into two rooms.
CREATE UNIQUE INDEX conversations_one_thread_per_message
    ON conversations (parent_message_id) WHERE parent_message_id IS NOT NULL;

-- Reading a message's room, and counting a hallway's rooms for their stubs.
CREATE INDEX conversations_parent_message ON conversations (parent_message_id)
    WHERE parent_message_id IS NOT NULL;

-- WHICH MESSAGE DELIVERED THE NOTICE.
--
-- delivery.py already reads this id back and puts it in a detail STRING —
-- `f"message {id} in conversation {cid}"` — so the value was in hand and
-- being thrown away. S25's "talk about this" needs something to hang a room
-- off, and a string in an audit field is not it.
--
-- ON DELETE SET NULL, not CASCADE: clearing the conversation must not
-- delete the RECORD that she raised something. The notice outlives the
-- message that carried it; it just stops having a room.
ALTER TABLE notices
    ADD COLUMN delivered_message_id uuid REFERENCES messages (id) ON DELETE SET NULL;

-- The seed reads every notice delivered by one message (a digest carries
-- several), so this is the access path that matters.
CREATE INDEX notices_delivered_message ON notices (delivered_message_id)
    WHERE delivered_message_id IS NOT NULL;
