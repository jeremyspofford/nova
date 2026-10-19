-- 0035 — M7 channels: Telegram and email bindings, signed approval links, and push (FR-110,
-- FR-111, FR-060; docs/13 §4-§6). All timestamps UTC ISO-8601, ids UUIDv7. Secrets (bot tokens,
-- mailbox passwords, the approval-link key, the VAPID key, Web Push auth secrets) live in the
-- secret store; rows hold only `secret://` references. Device, notification and approval ids are
-- plain TEXT so history rows outlive what they name.

-- Where a poller left off for a credential group: a Telegram update offset, or an email folder's
-- UIDVALIDITY and last UID. Keyed by the group's first binding.
CREATE TABLE channel_cursor (
  binding_id TEXT PRIMARY KEY REFERENCES channel_binding (id) ON DELETE CASCADE,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Signed approval links sent by email (docs/13 §4): the link carries this id and an HMAC with the
-- Hub's link key; the row makes it single use. Plain email text never answers an approval.
CREATE TABLE channel_approval_link (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  binding_id TEXT NOT NULL REFERENCES channel_binding (id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set when the link answered (or was spent by a refused answer).
  used_at TEXT,
  decision TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_channel_approval_link_approval ON channel_approval_link (approval_id);

-- Web Push subscriptions (FR-111, RFC 8030/8291): the push service endpoint and the browser's
-- public key; the auth secret is in the vault under `auth_ref`.
CREATE TABLE push_subscription (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_ref TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'failing', 'gone')),
  failures INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX push_subscription_endpoint ON push_subscription (account_id, endpoint);

-- Each push the Hub sent (FR-111): where it went and how it ended, never what it said. Kept 7
-- days.
CREATE TABLE push_delivery (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  notification_id TEXT,
  -- webpush: a push_subscription id; relay: the account's native clients through the Relay.
  target_kind TEXT NOT NULL CHECK (target_kind IN ('webpush', 'relay')),
  target_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'gone', 'skipped')),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_push_delivery_created ON push_delivery (account_id, created_at);
