-- 0044 — M7.5 device operations (ADR-096 D9; FR-126, FR-150). Decommissioning a novad device
-- (an owner request, an approval card, a Hub-signed authorization the device checks, then the
-- device's revocation) and the policy the Hub keeps for compute nodes (quiet hours and routing
-- eligibility, the compute node's equivalent of a novad device's pushed policy). The Hub's
-- client certificate for the management channel (D1) is a vault entry, not a row. Timestamps are
-- UTC ISO-8601, ids UUIDv7.

-- One decommission of a novad device. It waits for its approval card, then runs once: the device
-- is told to wipe itself when it is reachable, and is revoked either way. At most one is open
-- per device. `cancelled`: withdrawn before it was answered (its card was cancelled by a Hub
-- restart, or the device was revoked through its own route meanwhile).
CREATE TABLE device_decommission (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  -- Also delete the device's Nova data (`novad uninstall --purge`).
  purge INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
    CHECK (status IN ('awaiting_approval', 'running', 'done', 'denied', 'expired', 'cancelled', 'failed')),
  approval_id TEXT REFERENCES approval (id),
  -- The authorization's change id (D2), once one was issued.
  change_id TEXT,
  -- What the device did: wiped itself, could not be reached, refused, or was not told.
  device_result TEXT
    CHECK (device_result IS NULL OR device_result IN ('wiped', 'unreachable', 'refused', 'not_told')),
  detail TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_device_decommission_device ON device_decommission (device_id, created_at);
CREATE INDEX idx_device_decommission_approval ON device_decommission (approval_id);
CREATE UNIQUE INDEX idx_device_decommission_open ON device_decommission (device_id)
  WHERE status IN ('awaiting_approval', 'running');

-- The owner's policy for a compute node (FR-126, FR-150): sent in every heartbeat answer, honored
-- by the node (no new jobs in quiet hours) and by routing (no node while it is quiet or not
-- eligible). One row per node, created on first change.
CREATE TABLE node_policy (
  device_id TEXT PRIMARY KEY REFERENCES device (id),
  -- JSON list of `HH:MM-HH:MM` ranges.
  quiet_hours TEXT NOT NULL DEFAULT '[]',
  -- IANA zone the ranges are read in; the node's own zone when NULL.
  time_zone TEXT,
  routing_eligible INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
