-- 0021 — M6 channels, event triggers, MCP event subscriptions and notification routing (FR-088,
-- FR-056, FR-201, FR-060; docs/06 `channel_binding`, `trigger`, `mcp_event_subscription`,
-- `mcp_event_delivery`; docs/09 §7, docs/13 §4). All timestamps UTC ISO-8601, ids UUIDv7. Secrets
-- (bot tokens, signing secrets, webhook tokens) live in the secret store; rows hold only
-- `secret://` references. `agent_id` is plain TEXT: the agent table belongs to the agents area,
-- and deleting an agent must not be blocked by its bindings or triggers (the agents area removes
-- them first). Run and thread ids written by history rows are plain TEXT too, so the history
-- outlives a run or a purged thread.

-- One external conversation bound to one thread of an agent (ADR-070). Bindings of one Slack or
-- Teams app share a `secret_ref` prefix (the app's bot token and signing secret); inbound events
-- reach the binding whose `external_ref` names their conversation.
CREATE TABLE channel_binding (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('inapp', 'slack', 'teams', 'telegram', 'email', 'webhook',
    'voice')),
  label TEXT NOT NULL,
  -- The adapter's conversation id: a Slack channel or DM id, a Teams conversation id, an email
  -- address, a webhook name.
  external_ref TEXT NOT NULL,
  -- private: the owner only (a DM); shared: other people can read the channel (docs/13 §4).
  audience TEXT NOT NULL DEFAULT 'shared' CHECK (audience IN ('private', 'shared')),
  -- This binding's own thread (ADR-070); NULL until the first message.
  thread_id TEXT REFERENCES thread (id) ON DELETE SET NULL,
  -- Private bindings only: use the agent's primary thread (the owner's DM and in-app share one).
  share_primary_thread INTEGER NOT NULL DEFAULT 0,
  -- Unknown senders are ignored unless this is set (identity mapping, docs/13 §4).
  allow_unknown INTEGER NOT NULL DEFAULT 0,
  -- Adapter settings without secrets: Slack bot user id and team, a Teams app id and service URL,
  -- a webhook callback URL.
  config_json TEXT,
  -- secret://channel/<owner binding id>: the prefix of this binding's secrets.
  secret_ref TEXT,
  -- Per-binding caps on turns started and messages sent (docs/13 §4).
  rate_per_minute INTEGER NOT NULL DEFAULT 10 CHECK (rate_per_minute BETWEEN 1 AND 600),
  rate_per_hour INTEGER NOT NULL DEFAULT 120 CHECK (rate_per_hour BETWEEN 1 AND 10000),
  -- 0: disconnected; inbound messages are ignored and nothing is sent.
  enabled INTEGER NOT NULL DEFAULT 1,
  status_detail TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (share_primary_thread = 0 OR audience = 'private')
);
CREATE INDEX idx_channel_binding_account ON channel_binding (account_id, kind, created_at);
CREATE INDEX idx_channel_binding_thread ON channel_binding (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX idx_channel_binding_agent ON channel_binding (agent_id) WHERE agent_id IS NOT NULL;

-- External users mapped to a Nova identity and permission scope, per account and channel kind.
-- `owner` may answer pre-approvable approvals from a channel; `member` may only message.
CREATE TABLE channel_identity (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, kind, external_id)
);

-- Messages in and out of a binding: dedupe of redelivered events, loop prevention (the agent's
-- own messages never start a turn) and the rate caps. The text itself is in the thread; only its
-- hash is kept here.
CREATE TABLE channel_message (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES channel_binding (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  -- The adapter's message id (inbound) or the delivery receipt id (outbound).
  external_id TEXT,
  conversation TEXT,
  thread_ref TEXT,
  sender TEXT,
  thread_id TEXT,
  turn_id TEXT,
  -- in: started|answered|ignored|dropped; out: sent|failed|withheld
  status TEXT NOT NULL,
  reason TEXT,
  text_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_channel_message_external ON channel_message (binding_id, direction,
  external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_channel_message_window ON channel_message (binding_id, direction, created_at);

-- Event triggers (FR-056, docs/09 §7). `schedule` triggers are a schedule's fires; the API creates
-- the event kinds only.
CREATE TABLE trigger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  schedule_id TEXT REFERENCES schedule (id) ON DELETE CASCADE,
  run_id TEXT,
  agent_id TEXT,
  project_id TEXT REFERENCES project (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'connector_event', 'mcp_event', 'fs_change',
    'email', 'schedule')),
  title TEXT NOT NULL,
  -- run: start a Work run (origin `trigger`); wake: a turn on the agent's thread (trigger `event`).
  action TEXT NOT NULL DEFAULT 'run' CHECK (action IN ('run', 'wake')),
  -- What the user wants done when it fires; the event payload is attached as untrusted data.
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 8000),
  -- A channel binding id (connector_event), a device id (fs_change) or an
  -- mcp_event_subscription id (mcp_event).
  source_ref TEXT,
  config_json TEXT,
  -- The payload field whose value is the event's dedupe key (default `id`).
  dedupe_key TEXT,
  -- secret://trigger/<id>: the webhook token and signing secret.
  secret_ref TEXT,
  autonomy TEXT NOT NULL DEFAULT 'standard' CHECK (autonomy IN ('ask_first', 'standard')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_trigger_account ON trigger (account_id, created_at);
CREATE INDEX idx_trigger_source ON trigger (kind, source_ref) WHERE source_ref IS NOT NULL;

-- Each event a trigger saw, by dedupe key: a repeated key starts nothing.
CREATE TABLE trigger_event (
  trigger_id TEXT NOT NULL REFERENCES trigger (id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  -- started|failed|skipped
  status TEXT NOT NULL,
  run_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  detail TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, dedupe_key)
);
CREATE INDEX idx_trigger_event_received ON trigger_event (trigger_id, received_at DESC);

-- MCP event subscriptions (FR-201): the id is also the webhook path segment
-- (/api/v1/mcp/events/<id>). Removing the server removes its subscriptions.
CREATE TABLE mcp_event_subscription (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  mcp_server_id TEXT NOT NULL REFERENCES mcp_server (id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES trigger (id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  -- The server's own subscription id.
  remote_ref TEXT,
  -- secret://mcp/<server id>/events/<id>: the signing secret the server signs deliveries with.
  webhook_secret_ref TEXT NOT NULL,
  filter_json TEXT,
  expires_at TEXT,
  -- Refresh is attempted from this time on.
  refresh_before TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'refreshing',
    'lapsed', 'failed', 'removed')),
  last_delivery_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mcp_event_subscription_refresh ON mcp_event_subscription (refresh_before)
  WHERE status IN ('pending', 'active', 'refreshing', 'lapsed');
CREATE INDEX idx_mcp_event_subscription_trigger ON mcp_event_subscription (trigger_id);

-- Accepted deliveries only: a row exists only for a delivery with a valid signature and at most
-- 256 KiB (docs/06 invariant 17); a known delivery id starts nothing. Kept 7 days.
CREATE TABLE mcp_event_delivery (
  subscription_id TEXT NOT NULL REFERENCES mcp_event_subscription (id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes <= 262144),
  run_id TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, delivery_id)
);
CREATE INDEX idx_mcp_event_delivery_received ON mcp_event_delivery (received_at);

-- Notification routing (FR-060): per category, where a notification goes. No row: in-app and OS,
-- no channel; approvals pass quiet hours.
CREATE TABLE notification_rule (
  account_id TEXT NOT NULL REFERENCES account (id),
  category TEXT NOT NULL CHECK (category IN ('approval', 'completion', 'error', 'attention',
    'system')),
  inapp INTEGER NOT NULL DEFAULT 1,
  os INTEGER NOT NULL DEFAULT 1,
  -- JSON array of channel binding ids.
  channels_json TEXT NOT NULL DEFAULT '[]',
  bypass_quiet INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, category)
);

-- Quiet hours (FR-060): a daily window in a time zone that defers non-urgent notifications.
CREATE TABLE quiet_hours (
  account_id TEXT PRIMARY KEY REFERENCES account (id),
  enabled INTEGER NOT NULL DEFAULT 0,
  -- HH:MM local times; an end before the start crosses midnight.
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  -- JSON array of weekdays (0 = Sunday) on which a window starts.
  days_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  updated_at TEXT NOT NULL
);

-- Channel deliveries of notifications; deferred ones wait here until quiet hours end.
CREATE TABLE notification_delivery (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  notification_id TEXT,
  binding_id TEXT NOT NULL REFERENCES channel_binding (id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  receipt TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_notification_delivery_due ON notification_delivery (due_at)
  WHERE status = 'pending';
