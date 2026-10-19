-- 0041 — M7.5 boot (FR-143, docs/23 §5.2, ADR-096 D5): named boot profiles per device, the boot
-- changes the owner asked a device for with their approvals, one-shot boot attempts watched by the
-- Hub, and per-device PXE boot tokens. Low-level boot and PXE are off by default
-- (`devices.boot.allowLowLevel`, `devices.pxe.enabled`). Timestamps UTC ISO-8601, ids UUIDv7.

-- A named bootloader entry of a device. Kernel arguments are not part of a profile in M7.5. A
-- deleted profile keeps its row for the attempts that name it.
CREATE TABLE boot_profile (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  name TEXT NOT NULL,
  -- The entry as `/agent/v1/boot/status` lists it.
  entry_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_boot_profile_name ON boot_profile (device_id, name)
  WHERE deleted_at IS NULL;

-- A privileged boot change the owner asked for (`try`, `commit`, `revert`). It is sent to the
-- device once, with a Hub-signed authorization (ADR-096 D2), and only after its approval card
-- was approved; a revert's approval is the owner's own request.
CREATE TABLE boot_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  kind TEXT NOT NULL CHECK (kind IN ('try', 'commit', 'revert')),
  profile_id TEXT REFERENCES boot_profile (id),
  -- The attempt a commit makes the default; the attempt a try started once it is sent.
  attempt_id TEXT,
  entry_id TEXT,
  -- The device request body without its authorization, as canonical JSON: exactly what the
  -- approval covers (its SHA-256 is the approval's args_hash and the authorization's bodySha256).
  body_json TEXT NOT NULL,
  -- The device's boot state when the owner asked ({booted, default, pending}): the card's "from"
  -- and the audit's before.
  before_json TEXT NOT NULL DEFAULT '{}',
  approval_id TEXT REFERENCES approval (id),
  -- The authorization's changeId (UUIDv7); never reused.
  change_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
    CHECK (status IN ('awaiting_approval', 'denied', 'expired', 'sent', 'failed')),
  error_code TEXT,
  error_reason TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  sent_at TEXT
);
CREATE INDEX idx_boot_request_device ON boot_request (device_id, created_at);
CREATE INDEX idx_boot_request_approval ON boot_request (approval_id);

-- A one-shot trial of a profile. At most one is pending per device. The device confirms it
-- (`ok`) or gives up on it (`reverted`) in its heartbeat; one still pending 120 s after its
-- deadline is `failed` by the Hub's watchdog.
CREATE TABLE boot_attempt (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  profile_id TEXT NOT NULL REFERENCES boot_profile (id),
  request_id TEXT NOT NULL REFERENCES boot_request (id),
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'reverted', 'failed')),
  reboot INTEGER NOT NULL,
  watchdog_seconds INTEGER NOT NULL,
  -- When the device gives up on the entry, by the Hub's clock.
  deadline TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  -- What the device's `boot.watchdog.ok` said: 1 it saw the trial entry booted, 0 it could not
  -- tell (GRUB reports no booted entry), NULL no report yet.
  verified INTEGER,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX idx_boot_attempt_pending ON boot_attempt (device_id)
  WHERE status = 'pending';
CREATE INDEX idx_boot_attempt_device ON boot_attempt (device_id, created_at);

-- A device's PXE boot token (`nvb_…`): the public iPXE routes authenticate by it. Only its
-- SHA-256 is kept; the value is shown once. At most one is active per device.
CREATE TABLE pxe_token (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE UNIQUE INDEX idx_pxe_token_active ON pxe_token (device_id) WHERE revoked_at IS NULL;
