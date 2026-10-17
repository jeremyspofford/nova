-- 0024 — novad devices (M6; FR-141, FR-142, FR-144, FR-145, FR-148, FR-150, FR-210, FR-081).
-- A novad device is a `device` row (0005) with kind client|hub|wake-helper (never `compute`, which
-- stays the M2 compute-node registration) and its management endpoint in `transport_endpoint`.
-- Its enrollment token is an `add_device_request` hashed in its own domain. The management token
-- the Hub presents to the device lives in the vault at secret://devices/<id>/management-token.

-- What the Hub keeps per novad device: protocol, update channel, the overrides and policy it
-- pushes (FR-142, FR-150) and the last module and power reports.
CREATE TABLE device_management (
  device_id TEXT PRIMARY KEY REFERENCES device (id),
  protocol_version INTEGER NOT NULL,
  update_channel TEXT NOT NULL DEFAULT 'stable'
    CHECK (update_channel IN ('stable', 'beta', 'nightly')),
  capability_overrides TEXT NOT NULL DEFAULT '{}',
  policy TEXT NOT NULL DEFAULT '{}',
  -- Bumped on every change; the device has taken the config when pushed_revision catches up.
  config_revision INTEGER NOT NULL DEFAULT 0,
  pushed_revision INTEGER NOT NULL DEFAULT 0,
  modules TEXT NOT NULL DEFAULT '[]',
  power TEXT,
  updated_at TEXT NOT NULL
);

-- Folder and MCP grants on a device per grantee, and the access requests that lead to them
-- (FR-210). A pending request waits on a Hub approval card or a decision on the device.
CREATE TABLE device_grant (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  grantee_kind TEXT NOT NULL CHECK (grantee_kind IN ('user', 'agent', 'session', 'run', 'thread')),
  grantee_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'mcp')),
  -- A canonical folder path on the device, or an MCP server name.
  target TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write', 'call')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'denied', 'revoked')),
  -- The request and grant ids on the device.
  device_request_id TEXT,
  device_grant_id TEXT,
  approval_id TEXT REFERENCES approval (id),
  reason TEXT,
  decided_by TEXT CHECK (decided_by IN ('device', 'hub')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_device_grant_grantee ON device_grant (device_id, grantee_kind, grantee_ref, status);
CREATE INDEX idx_device_grant_approval ON device_grant (approval_id);
CREATE UNIQUE INDEX idx_device_grant_request ON device_grant (device_id, device_request_id)
  WHERE device_request_id IS NOT NULL;

-- Two-phase device writes (FR-210, docs/06 §7). The content waits in novad's staging area
-- (`blob_path` names it); the Hub keeps the diff it shows before a commit.
CREATE TABLE staged_write (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  device_stage_id TEXT NOT NULL,
  grantee_kind TEXT NOT NULL,
  grantee_ref TEXT NOT NULL,
  -- The thread, run, Code session or agent that staged it.
  session_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  base_sha256 TEXT,
  new_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_path TEXT NOT NULL,
  diff TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged', 'committed', 'discarded', 'conflict', 'expired', 'failed')),
  approval_id TEXT REFERENCES approval (id),
  error TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE INDEX idx_staged_write_device ON staged_write (device_id, status, created_at);
CREATE INDEX idx_staged_write_session ON staged_write (account_id, session_ref, created_at);

-- Wake-on-LAN requests (FR-144, docs/06 §7): rate-limited and logged. In M6 the Hub sends the
-- magic packet itself (helper_device_id NULL); a Wake Helper sends it from M6.5 (FR-138).
CREATE TABLE wake_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  target_device_id TEXT NOT NULL REFERENCES device (id),
  helper_device_id TEXT REFERENCES device (id),
  mac TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'rate_limited')),
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_wake_request_target ON wake_request (target_device_id, created_at);

-- Signed updates pushed to a device and how they ended (FR-148).
CREATE TABLE device_update (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  target TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back', 'staged', 'refused', 'failed')),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_device_update_device ON device_update (device_id, created_at);

-- An agent's connected computer (FR-081): one active connection per agent, explicit and
-- revocable. `agent_id` is plain TEXT on purpose: the agent table belongs to the agents area.
CREATE TABLE agent_device_connection (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  agent_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES device (id),
  capabilities TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_agent_device_connection_active ON agent_device_connection (agent_id)
  WHERE status = 'active';
CREATE INDEX idx_agent_device_connection_device ON agent_device_connection (device_id, status);
