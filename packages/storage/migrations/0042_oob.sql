-- 0042 — M7.5 out-of-band management (FR-147; docs/23 §7; ADR-096 D6). The Hub reaches the BMCs
-- the owner registered: Redfish over HTTPS with the BMC certificate pinned, IPMI through ipmitool;
-- Intel AMT is not built. The user name and password live in the vault under `secret://oob/<id>`:
-- rows hold only that reference, never a credential. All timestamps UTC ISO-8601, ids UUIDv7.

-- A BMC the owner registered. The registry is the allowlist: the Hub contacts no other address.
CREATE TABLE oob_endpoint (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('redfish', 'ipmi', 'amt')),
  -- A host name or IP literal (no URL, no credentials); `port` null means the protocol default.
  address TEXT NOT NULL,
  port INTEGER,
  -- Redfish: which ComputerSystem to manage when the service lists several.
  system_id TEXT,
  credential_ref TEXT NOT NULL,
  -- The device this BMC belongs to (a failed-boot alert offers its power cycle).
  device_id TEXT REFERENCES device (id) ON DELETE SET NULL,
  -- SHA-256 of the BMC certificate's DER (lower-case hex), read on first use or entered.
  tls_pin TEXT,
  tls_pinned_at TEXT,
  -- When the owner confirmed the pin (an entered pin is confirmed). Credentials are sent to a
  -- Redfish BMC only once its pin is confirmed.
  tls_pin_confirmed_at TEXT,
  last_check_at TEXT,
  last_check_ok INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_oob_endpoint_account ON oob_endpoint (account_id, created_at);
CREATE INDEX idx_oob_endpoint_device ON oob_endpoint (device_id);

-- Every action asked of a BMC, with its approval and the values before and after. A `bios.plan`
-- row holds the plan (snapshot and diff) its approval covers; `bios.apply` names it in `plan_id`.
-- Rows outlive their endpoint (`endpoint_name` keeps what it was called).
CREATE TABLE oob_action (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  endpoint_id TEXT REFERENCES oob_endpoint (id) ON DELETE SET NULL,
  endpoint_name TEXT NOT NULL,
  action TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  params_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'running', 'done',
    'failed', 'denied', 'expired', 'applied')),
  approval_id TEXT,
  plan_id TEXT,
  before_json TEXT,
  after_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_reason TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_oob_action_endpoint ON oob_action (endpoint_id, created_at);
CREATE INDEX idx_oob_action_account ON oob_action (account_id, created_at);
CREATE INDEX idx_oob_action_approval ON oob_action (approval_id);
