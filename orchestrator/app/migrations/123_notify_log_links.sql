-- Inbox messages link to the thing they're about. The dashboard Inbox can
-- then show the referenced item's LIVE status (approved / expired / task
-- complete) and a jump link, instead of a dead-end one-liner that claims
-- something is "waiting" forever.
ALTER TABLE notify_log ADD COLUMN IF NOT EXISTS approval_id UUID;
ALTER TABLE notify_log ADD COLUMN IF NOT EXISTS task_id UUID;
