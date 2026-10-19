-- 0040 — M7.5 firmware (FR-146; docs/23 §6; ADR-042, ADR-096 D2-D4): BIOS/firmware changes on
-- novad devices, off by default (`devices.firmware.allowChanges`). Every change is planned on the
-- device (a dry run with a snapshot), approved by the owner on an `approval` card showing the
-- diff, applied with a Hub-signed authorization, and can be rolled back. All timestamps are UTC
-- ISO-8601 and ids UUIDv7. No BIOS password is ever stored here (it stays in the vault at
-- secret://devices/<id>/bios-admin).

-- The Hub's copy of a snapshot the device took when it planned a change: the allowlisted values
-- before the change. The values are sealed with the Hub data key in a file under the data folder
-- (`blob_path`, relative to it); the row keeps their keys and hash only.
CREATE TABLE firmware_snapshot (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  device_snapshot_id TEXT NOT NULL,  -- the snapshot's id on the device
  taken_at TEXT NOT NULL,
  keys_json TEXT NOT NULL DEFAULT '[]',
  sha256 TEXT NOT NULL,              -- hex SHA-256 of the canonical JSON of the values
  blob_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_firmware_snapshot_device ON firmware_snapshot (device_id, device_snapshot_id);

-- One change (docs/06 `firmware_change`, extended): the settings one plan sets (`kind` apply) or
-- a snapshot restored (`kind` rollback). `setting` lists the canonical keys; `old_value` and
-- `new_value` are JSON objects {key: value} of the values before and after; `diff_json` is the
-- diff the approval card showed. `change_id` is the D2 changeId of the last authorization the Hub
-- signed for it (a fresh one for each attempt, never reused). Applied only after its approval is
-- approved (docs/06 invariant).
CREATE TABLE firmware_change (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL REFERENCES device (id),
  kind TEXT NOT NULL CHECK (kind IN ('apply', 'rollback')),
  setting TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  diff_json TEXT NOT NULL DEFAULT '[]',
  refused_json TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL,              -- firmware-attributes|efibootmgr|fake|unknown
  plan_id TEXT,                      -- the device's plan id (kind apply)
  snapshot_ref TEXT REFERENCES firmware_snapshot (id),
  rollback_of TEXT REFERENCES firmware_change (id),
  security_degrading INTEGER NOT NULL DEFAULT 0,
  requires_reboot INTEGER NOT NULL DEFAULT 0,
  reboot INTEGER,                    -- what apply asked for
  -- `revert_failed`: the device's watchdog reported a restore that failed or was partial; the
  -- change stays in place and can still be rolled back.
  status TEXT NOT NULL CHECK (status IN ('planned', 'awaiting_approval', 'approved', 'applied',
    'rolled_back', 'failed', 'reverted', 'revert_failed')),
  approval_id TEXT REFERENCES approval (id),
  change_id TEXT,
  watchdog_state TEXT CHECK (watchdog_state IS NULL
    OR watchdog_state IN ('pending', 'ok', 'reverted', 'revert_failed', 'missed')),
  watchdog_deadline TEXT,
  -- novad's reason for a revert: `deadline` (restarted into the change, not back in time) or
  -- `not_restarted` (never restarted before the deadline).
  watchdog_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  CHECK (status NOT IN ('applied', 'rolled_back', 'reverted', 'revert_failed')
    OR approval_id IS NOT NULL)
);
CREATE INDEX idx_firmware_change_device ON firmware_change (device_id, created_at);
CREATE UNIQUE INDEX idx_firmware_change_authz ON firmware_change (change_id)
  WHERE change_id IS NOT NULL;

-- Where an approval may be answered (docs/23 §6.3 "explicit approval on the Hub"): NULL anywhere
-- its tier allows; `hub` only by the signed-in user in a Nova client (web, desktop), never from a
-- channel (a reply, a button, a signed email link) or a hook. Firmware, boot, out-of-band and
-- decommission cards set it.
ALTER TABLE approval ADD COLUMN answer_in TEXT CHECK (answer_in IS NULL OR answer_in = 'hub');
