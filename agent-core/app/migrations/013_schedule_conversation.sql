-- Migration 013: per-schedule conversation thread — scheduled run results surface in chat.
-- ON DELETE SET NULL: deleting the conversation in the chat UI detaches it; the next
-- run lazily creates a fresh thread.
ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS conversation_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
