-- 0037 — M7 team (FR-217, FR-091, FR-113, FR-045 per agent; decision 5, ADR-095): the people of
-- one Hub, one-use invitations, OIDC sign-in, opt-in public profile cards, shared threads,
-- specialist/team agents with their own identity, and the plugins connected to an agent. Secrets
-- never land here: the OIDC client secret and team agents' credentials are `secret://` references
-- held by the vault. All timestamps UTC ISO-8601, ids UUIDv7.

-- The people of the Hub. The owner's row (role `owner`) is written at setup, or the first time the
-- team area starts on a Hub from before M7; a member has their own account (memory, connectors,
-- sessions) and is never the owner.
CREATE TABLE team_member (
  account_id TEXT PRIMARY KEY REFERENCES account (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  invitation_id TEXT,
  invited_by TEXT REFERENCES account (id),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT
);
CREATE UNIQUE INDEX uq_team_member_owner ON team_member (role) WHERE role = 'owner';

-- One-use invitation links (like setup codes): only the token's SHA-256 is stored.
CREATE TABLE team_invitation (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  label TEXT CHECK (label IS NULL OR length(label) <= 100),
  created_by TEXT NOT NULL REFERENCES account (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT REFERENCES account (id),
  revoked_at TEXT
);
CREATE INDEX idx_team_invitation_created ON team_invitation (created_at);

-- An OIDC provider the owner configured (FR-113, docs/13 §7). The client secret is a vault entry
-- (`secret://team/oidc/<id>`); NULL for a public client, which relies on PKCE alone.
CREATE TABLE oidc_provider (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  issuer TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_secret_ref TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES account (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- An account linked to an OIDC identity (issuer + subject). One identity per provider per account.
CREATE TABLE oidc_identity (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  provider_id TEXT NOT NULL REFERENCES oidc_provider (id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  email TEXT,
  linked_at TEXT NOT NULL,
  last_sign_in_at TEXT,
  UNIQUE (provider_id, subject),
  UNIQUE (account_id, provider_id)
);

-- The opt-in public profile card (FR-113): read-only, display name and (optionally) the avatar.
CREATE TABLE profile_card (
  account_id TEXT PRIMARY KEY REFERENCES account (id),
  handle TEXT NOT NULL UNIQUE CHECK (length(handle) BETWEEN 3 AND 40),
  enabled INTEGER NOT NULL DEFAULT 0,
  show_avatar INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- A thread shared with other people of the Hub (FR-217): one row per participant other than the
-- thread's owner. A shared thread is memory opt-out, and nobody's memory joins its turns.
CREATE TABLE thread_share (
  thread_id TEXT NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  owner_account_id TEXT NOT NULL REFERENCES account (id),
  shared_by TEXT NOT NULL REFERENCES account (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, account_id)
);
CREATE INDEX idx_thread_share_account ON thread_share (account_id, created_at);

-- Who wrote each user message of a shared thread ("who said what"). The id is plain: a queued
-- message keeps its queue id when it becomes a message.
CREATE TABLE shared_message (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_shared_message_thread ON shared_message (thread_id, created_at);

-- A specialist/team agent (FR-091): an always-on agent that lives in its own identity account (not
-- a person's), so its memory, connectors, credentials, policy and audit are its own.
CREATE TABLE team_agent (
  agent_id TEXT PRIMARY KEY REFERENCES agent (id) ON DELETE CASCADE,
  identity_account_id TEXT NOT NULL UNIQUE REFERENCES account (id),
  created_by TEXT NOT NULL REFERENCES account (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Credentials bound to a team agent: a provider account or an egress credential of its identity
-- account (their values are vault entries there). Bookkeeping for the admin's list.
CREATE TABLE team_agent_credential (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES team_agent (agent_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('provider', 'egress')),
  ref_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  created_by TEXT NOT NULL REFERENCES account (id),
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, kind, ref_id)
);

-- A task a person gave a team agent: it runs under the agent's identity, in a thread of its own
-- (`thread_id`), never on the agent's main thread.
CREATE TABLE team_task (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES team_agent (agent_id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES account (id),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  thread_id TEXT,
  turn_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX idx_team_task_agent ON team_task (agent_id, created_at);
CREATE INDEX idx_team_task_requester ON team_task (requested_by, created_at);

-- The plugins connected to an agent (FR-045, docs/04 §2.5): its threads may use only their tools.
-- No row: every plugin the account enabled, as before.
CREATE TABLE agent_plugin_scope (
  agent_id TEXT PRIMARY KEY REFERENCES agent (id) ON DELETE CASCADE,
  plugin_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A member's own preferences (appearance, keyboard, onboarding): Hub settings stay the owner's.
CREATE TABLE member_setting (
  account_id TEXT NOT NULL REFERENCES account (id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
