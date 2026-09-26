-- S42a (the hub lane): Nova's agent runs on Linux, macOS and Windows, and
-- reports facts about its machine.
--
-- devices.platform gets the CHECK it never had. Enroll stored free text until
-- now (devices.py) and every agent sent the literal "linux", so a value
-- outside the four becomes 'unknown' FIRST — or adding the CHECK would fail
-- on it. From S42a, enroll refuses anything but linux|darwin|windows
-- (device_facts.PLATFORMS); 'unknown' is only ever what this migration
-- writes.
--
-- facts / facts_at hold what the agent last said about its machine;
-- device_facts.validate_auth / validate_frame keep only what core
-- understands. A dated pair, like the gateway's engine facts
-- (009_engines.sql): both NULL until an agent first reports, both set after.
-- No ROLE is stored — roles are derived on every read (device_facts), so a
-- stored one can never outlive the fact it came from — and no capabilities
-- column exists (test_no_approvals.py pins that).
--
-- The machine_uid index serves the duplicate-agent check: two live agents
-- reporting one machine (app/checks/devices.py).
--
-- Re-runnable: every statement is idempotent, because its test re-executes it
-- on a migrated database.
UPDATE devices SET platform = 'unknown'
 WHERE platform NOT IN ('linux', 'darwin', 'windows', 'unknown');

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_platform;
ALTER TABLE devices ADD CONSTRAINT devices_platform
    CHECK (platform IN ('linux', 'darwin', 'windows', 'unknown'));

ALTER TABLE devices ADD COLUMN IF NOT EXISTS facts jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS facts_at timestamptz;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_facts_dated;
ALTER TABLE devices ADD CONSTRAINT devices_facts_dated
    CHECK ((facts IS NULL) = (facts_at IS NULL));

CREATE INDEX IF NOT EXISTS devices_machine_uid
    ON devices ((facts->>'machine_uid'))
 WHERE revoked_at IS NULL;
