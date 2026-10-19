-- 0043 — M7.5 browser_device (FR-209, FR-096; docs/11 §4.3, §4.6; ADR-096 D7, D8): the local
-- browser fallback and the extension bridge. All timestamps UTC ISO-8601, ids UUIDv7. Device,
-- computer and thread ids are plain TEXT (no foreign keys): devices are revoked, not deleted, and
-- a trace or a consent must never block a purge. Nothing secret lives here.

-- A revocable consent to continue a site on a device's browser (FR-209), per agent or thread.
-- At most one live consent per scope, device and site; revoking keeps the row for the record.
CREATE TABLE browser_fallback_consent (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('agent', 'thread')),
  scope_ref TEXT NOT NULL,
  device_id TEXT NOT NULL,
  site TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('clean', 'extension')),
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX ux_browser_fallback_consent_live
  ON browser_fallback_consent (account_id, scope_kind, scope_ref, device_id, site)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_browser_fallback_consent_device ON browser_fallback_consent (device_id);

-- One local-fallback browser session (D7): the computer whose browser moved to the device, why,
-- and how it ended, with the egress filter's counts when novad reported them.
CREATE TABLE browser_fallback_session (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  computer_id TEXT NOT NULL,
  thread_id TEXT,
  device_id TEXT NOT NULL,
  site TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('clean', 'extension')),
  cause TEXT NOT NULL CHECK (cause IN ('block_page', 'repeated_challenge', 'requested')),
  consent_id TEXT REFERENCES browser_fallback_consent (id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (
    end_reason IN (
      'closed', 'left_site', 'consent_revoked', 'device_gone', 'error', 'disabled', 'restarted'
    )
  ),
  egress_allowed INTEGER,
  egress_refused INTEGER,
  -- In the user's own browser (profile `extension`): the OS user whose browser it was.
  bridge_user TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX idx_browser_fallback_session_computer
  ON browser_fallback_session (account_id, computer_id, started_at);

-- The trace mark (FR-098): each browser_action row recorded during a fallback session. It goes
-- with the trace row when retention or a purge removes that.
CREATE TABLE browser_fallback_action (
  action_id TEXT PRIMARY KEY REFERENCES browser_action (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES browser_fallback_session (id) ON DELETE CASCADE
);
CREATE INDEX idx_browser_fallback_action_session ON browser_fallback_action (session_id);

-- Per-host grants of the extension bridge (FR-096). `host` '*' is the separate "all sites"
-- grant. `pending`: the extension reported the browser's permission and the owner has not
-- confirmed it; only `active` (owner-confirmed) grants count. `browser_permission` mirrors what the
-- extension last reported for the host. At most one live grant per device and host.
CREATE TABLE browser_bridge_grant (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  device_id TEXT NOT NULL,
  host TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  browser_permission INTEGER NOT NULL DEFAULT 0,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK (state <> 'active' OR confirmed_at IS NOT NULL),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_browser_bridge_grant_live
  ON browser_bridge_grant (device_id, host)
  WHERE state <> 'revoked';
CREATE INDEX idx_browser_bridge_grant_account ON browser_bridge_grant (account_id, device_id);
