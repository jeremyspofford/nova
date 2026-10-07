-- Chat sessions (owner, 2026-10-07): several top-level conversations at once,
-- listed in a sidebar, each archivable, deletable and openable side by side.
--
-- WHICH CONVERSATIONS ARE HIS SESSIONS. `conversations` also holds rows that
-- are not his to pick from: the beats' own log, each agent's log and every
-- eval case's scratch conversation (all `active = false` with a title), and
-- every S24 room (`parent_message_id` set). None of those is a chat he opened,
-- and a list filtered by "not active" would hand him all of them. So the fact
-- is a column, written by the two paths that create a session (the hallway's
-- first-ask insert and POST /conversations) and by nothing else — a beat or an
-- agent log cannot become a session by forgetting a predicate.
--
-- WHICH ONE IS THE HALLWAY is unchanged: `active`. Delivery, reminders set
-- outside a chat, and `/conversations/active` still read the newest active,
-- unthreaded row. A new session is created INACTIVE, so opening one never moves
-- where a digest is delivered; "Make main" moves it on purpose.
ALTER TABLE conversations ADD COLUMN chat_session boolean NOT NULL DEFAULT false;

-- Archived: kept, out of the default list. NULL is live. A timestamp rather
-- than a flag so the archived list can say when.
ALTER TABLE conversations ADD COLUMN archived_at timestamptz;

-- Every hallway that exists today was his chat: it becomes a session.
UPDATE conversations SET chat_session = true WHERE active AND parent_message_id IS NULL;

CREATE INDEX conversations_person_chat_sessions
    ON conversations (person_id, created_at DESC) WHERE chat_session;
