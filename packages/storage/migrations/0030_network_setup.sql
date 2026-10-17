-- 0030 — M6.5 Network Setup assistant (FR-136; docs/22 §6): setup runs, their steps, the
-- snapshots a rollback restores, and the owner's remembered consents. All timestamps UTC
-- ISO-8601, ids UUIDv7. No secret is stored here: an auth key or API key is a `secret://` ref in
-- `options_json`, and command lists hold argv only (secrets reach a CLI through its environment or
-- stdin). `change_ref` names the network area's change-log entry as plain TEXT (that table belongs
-- to another area).

CREATE TABLE network_setup_run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  provider TEXT NOT NULL CHECK (provider IN ('headscale', 'tailscale', 'netbird', 'wireguard')),
  status TEXT NOT NULL
    CHECK (status IN ('planned', 'in_progress', 'completed', 'failed', 'rolled_back')),
  -- The owner's options with write-only secrets replaced by vault refs.
  options_json TEXT NOT NULL,
  -- Public material the owner needs (e.g. the Hub's WireGuard public key).
  outputs_json TEXT NOT NULL DEFAULT '{}',
  -- The detection the plan was made from.
  detection_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_network_setup_run_account ON network_setup_run (account_id, created_at);

CREATE TABLE network_setup_step (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES network_setup_run (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  -- headscale | tailscale | netbird | wireguard | ufw | os | hub
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('change', 'manual', 'skip', 'check')),
  title TEXT NOT NULL,
  -- What the owner confirms word for word (one-time consent).
  description TEXT NOT NULL,
  commands_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  affects_json TEXT NOT NULL,
  undo_affects_json TEXT NOT NULL,
  expects_json TEXT NOT NULL,
  system_change INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'applied', 'verified', 'failed', 'rolled_back', 'rollback_failed', 'manual',
      'skipped'
    )
  ),
  checks_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  auto_rolled_back INTEGER NOT NULL DEFAULT 0,
  change_ref TEXT,
  applied_at TEXT,
  verified_at TEXT,
  rolled_back_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, idx)
);

-- What a step changed, taken before it changed it, and the undo commands planned from it.
CREATE TABLE network_setup_snapshot (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES network_setup_step (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES network_setup_run (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  data_json TEXT NOT NULL,
  undo_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_network_setup_snapshot_step ON network_setup_snapshot (step_id, created_at);

-- One-time consent per change kind and provider (docs/22 §6.2), until the owner revokes it.
CREATE TABLE network_setup_consent (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  description TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_network_setup_consent_active
  ON network_setup_consent (account_id, kind, provider)
  WHERE revoked_at IS NULL;
