-- 096_notify_log.sql
-- Delivery receipts for phone push: every publish attempt (including
-- suppressed ones — notifications disabled, no topic) is recorded with its
-- outcome so the operator can see what Nova tried to send and whether the
-- ntfy server accepted it. Surfaced in Settings → Notifications.
-- NOTE: "ok" means the ntfy server accepted the publish — actual delivery
-- still depends on a device being subscribed to the topic.

CREATE TABLE IF NOT EXISTS notify_log (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event TEXT NOT NULL,
    title TEXT NOT NULL,
    ok BOOLEAN NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_notify_log_created_at
    ON notify_log (created_at DESC);
