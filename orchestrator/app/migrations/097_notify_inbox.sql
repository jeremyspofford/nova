-- 097_notify_inbox.sql
-- The notify_log grows into the operator's in-dashboard Inbox: keep the full
-- message body (not just the title) and per-message read state, so briefings
-- and agent pushes are readable inside Nova even when no phone/email/ntfy
-- client is set up. The push channel is an optional delivery leg; the Inbox
-- is the canonical surface.

ALTER TABLE notify_log ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';
ALTER TABLE notify_log ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notify_log_unread
    ON notify_log (created_at DESC)
    WHERE read_at IS NULL;
