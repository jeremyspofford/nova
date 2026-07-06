-- Checkpoint screenshots (task #8 milestone C)
-- Optional page screenshot attached by request_human_checkpoint so the
-- operator sees what the agent sees (CAPTCHA, form state). Stored inline:
-- rows are few and short-lived, and inline storage keeps backup/restore and
-- cascade semantics for free. The pending-approvals LIST endpoint strips it;
-- only the single-approval detail endpoint returns it.
ALTER TABLE approval_requests
    ADD COLUMN IF NOT EXISTS screenshot_b64 TEXT;
