-- 0029 — network (M6.5; FR-135, FR-139, docs/22 §2, §6, §9.5, §9.7): the health history of the
-- Hub's own endpoints, the transport events log (an endpoint advertised or withdrawn, a transport
-- up or down, the preferred transport changing: the logged fallback) and the network change log
-- behind one-click rollback. Wakes stay in wake_request (0024), whose helper_device_id names the
-- Wake Helper that sent a packet (FR-138); it is rebuilt here to allow `pending`.

-- One row per reachability probe of a candidate endpoint; pruned to the last 7 days.
CREATE TABLE network_endpoint_check (
  id TEXT PRIMARY KEY,
  transport TEXT NOT NULL CHECK (transport IN ('lan', 'mesh', 'relay', 'direct')),
  url TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('ok', 'failing')),
  latency_ms INTEGER,
  detail TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX idx_network_endpoint_check_url ON network_endpoint_check (url, checked_at);
CREATE INDEX idx_network_endpoint_check_at ON network_endpoint_check (checked_at);

-- Changes to what the Hub advertises; `primary` names the new preferred transport in
-- `transport` (NULL: nothing advertised) and the previous one in `from_transport`.
CREATE TABLE network_transport_event (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('advertised', 'withdrawn', 'up', 'down', 'off', 'primary')),
  transport TEXT CHECK (transport IN ('lan', 'mesh', 'relay', 'direct')),
  from_transport TEXT CHECK (from_transport IN ('lan', 'mesh', 'relay', 'direct')),
  url TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_network_transport_event_at ON network_transport_event (created_at);

-- Every network change with what undoes it (docs/22 §9.5). `undo_json` is a serializable
-- descriptor handled by the undo handler registered for `kind`; it never holds a secret, only
-- `secret://` references. `error` keeps the last failed rollback attempt.
CREATE TABLE network_change (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES account (id),
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  undo_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rolled_back')),
  error TEXT,
  created_at TEXT NOT NULL,
  rolled_back_at TEXT
);
CREATE INDEX idx_network_change_status ON network_change (status, created_at);

-- A wake counts toward the per-hour limit from the moment it starts (FR-144, FR-138): a `pending`
-- row is written in the same transaction as the count, before a Wake Helper is called, and
-- becomes `sent` or `failed`. SQLite cannot change a CHECK constraint, so the table is rebuilt
-- (nothing references it).
CREATE TABLE wake_request_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  target_device_id TEXT NOT NULL REFERENCES device (id),
  helper_device_id TEXT REFERENCES device (id),
  mac TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'rate_limited')),
  error TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO wake_request_new (id, account_id, target_device_id, helper_device_id, mac, status, error, created_at)
  SELECT id, account_id, target_device_id, helper_device_id, mac, status, error, created_at FROM wake_request;
DROP TABLE wake_request;
ALTER TABLE wake_request_new RENAME TO wake_request;
CREATE INDEX idx_wake_request_target ON wake_request (target_device_id, created_at);
