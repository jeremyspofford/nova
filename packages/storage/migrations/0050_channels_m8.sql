-- 0050 — M8 channels (FR-110; docs/13 §4). Telegram files are kept as thread attachments
-- (`attachment`, origin `import`); an email mailbox's OAuth tokens and their state (status,
-- expiry, scopes, last error) are vault entries of its credential group
-- (`secret://channel/<id>/oauthAccessToken`, `…/oauthRefreshToken`, `…/oauthState`), never rows.

-- The files of a message-log entry (`channel_message`): what an inbound message carried (received
-- and kept as an attachment, or refused) and each file sent out (sent, withheld, failed). No
-- content: names, sizes and types only; the bytes are the attachment or artifact.
CREATE TABLE channel_message_file (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES channel_message (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  status TEXT NOT NULL CHECK (status IN ('received', 'sent', 'withheld', 'failed')),
  name TEXT NOT NULL,
  size INTEGER,
  content_type TEXT,
  -- The thread attachment it was kept as (inbound) or sent from (outbound); plain ids, so the
  -- log outlives them.
  attachment_id TEXT,
  artifact_id TEXT,
  -- Why it was withheld or failed.
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_channel_message_file ON channel_message_file (message_id, idx);
