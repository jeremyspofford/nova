-- S42b (the hub lane): Nova's agent installs, re-pairs and updates itself.
-- The next free number after the production hotfix 037 (device_audit
-- exit_code -> bigint). Re-runnable: its test executes it a second time,
-- including against a database that already carries devices, device_audit
-- rows and pairing codes from before this migration existed.

-- Re-pair (decision 4): a code may be bound to one live device. Enrolling
-- with it rebinds that row to the new key — name and history kept — instead
-- of inserting a row. Revoking or deleting the device kills its codes.
ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS device_id uuid
    REFERENCES devices (id) ON DELETE CASCADE;
-- The name a new machine takes when the card that minted the code named it
-- (NULL: the agent's own, its hostname). A re-pair keeps the row's name.
ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS name text;

-- A re-pair restarts the device's audit chain under a new epoch: the old
-- chain's rows stay (history), and the new key's chain starts at seq 0
-- without a false DEVICE_AUDIT_BREAK. Existing devices and their existing
-- device_audit rows default to epoch 0 — the chain they were already on.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS audit_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE device_audit ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 0;
ALTER TABLE device_audit DROP CONSTRAINT IF EXISTS device_audit_pkey;
ALTER TABLE device_audit ADD CONSTRAINT device_audit_pkey PRIMARY KEY (device_id, epoch, seq);

-- The door the agent's socket last came through (P15): 'host' for the hub's
-- own loopback port, 'tailnet' through the sidecar, NULL when neither could
-- be derived. An observation stamped at each authenticated connect, never a
-- flag anyone sets; S43a/S48/S49 widen the CHECK with their doors.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_transport text;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_last_transport;
ALTER TABLE devices ADD CONSTRAINT devices_last_transport
    CHECK (last_transport IN ('host', 'tailnet'));

-- A revoked device's agent that is still running keeps knocking (P28): the
-- last knock whose signature verified against its revoked key, so "is the old
-- agent still running?" has an answer that is a record, not a guess.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_refused_at timestamptz;

-- The update ledger (decision 2): one row per attempt. `sent` until the
-- device's next authenticated connection decides it (P8). One `sent` row at a
-- time, for everyone who can ask (P9) — system-wide, not per device: the
-- partial unique index is on a constant, not on device_id.
CREATE TABLE IF NOT EXISTS agent_updates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    from_version text,
    version      text NOT NULL CHECK (version ~ '^[0-9a-f]{12}$'),
    sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    path         text NOT NULL CHECK (path IN ('capability', 'bootstrap')),
    requested_by text NOT NULL CHECK (requested_by IN ('nova', 'owner', 'reconciler')),
    sent_at      timestamptz NOT NULL DEFAULT now(),
    outcome      text NOT NULL DEFAULT 'sent'
                 CHECK (outcome IN ('sent', 'confirmed', 'rolled_back', 'not_confirmed', 'refused')),
    outcome_at   timestamptz,
    reason       text,
    CONSTRAINT agent_updates_decided_when CHECK ((outcome = 'sent') = (outcome_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_updates_one_in_flight ON agent_updates ((true)) WHERE outcome = 'sent';
CREATE INDEX IF NOT EXISTS agent_updates_by_device ON agent_updates (device_id, sent_at DESC);
