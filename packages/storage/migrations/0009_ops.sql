-- 0009 — M3 audit log and notifications (docs/06 §2 "audit & events" and "notifications";
-- docs/12 §11; FR-013, FR-104 partial). All timestamps UTC ISO-8601, ids UUIDv7.

-- Append-only audit log with a SHA-256 hash chain: `hash` covers the canonical JSON of the row
-- without `hash` (so including `seq` and `prev_hash`). Inputs are stored as a hash only.
CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  -- Position in the chain (1, 2, 3, ...); verification walks it in this order.
  seq INTEGER NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES account (id),
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  input_hash TEXT,
  decision TEXT,
  result TEXT,
  detail_json TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_event (created_at DESC);
CREATE INDEX idx_audit_account ON audit_event (account_id, seq);
CREATE INDEX idx_audit_thread ON audit_event (thread_id, seq);

-- The database itself refuses to rewrite history; tampering needs direct file access, which
-- verification then detects.
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;

-- Notification center (FR-013). `dedupe_key` collapses repeats of the same thing while unread.
CREATE TABLE notification (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'completion', 'error', 'attention', 'system')),
  title TEXT NOT NULL,
  body TEXT,
  -- Where clicking it goes: an app path such as /chat/<id>.
  href TEXT,
  refs_json TEXT,
  dedupe_key TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notification_account ON notification (account_id, created_at DESC);
CREATE UNIQUE INDEX idx_notification_dedupe ON notification (account_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND read = 0;
