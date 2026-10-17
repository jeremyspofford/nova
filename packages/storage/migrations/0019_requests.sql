-- 0019 — M5 server-to-client requests (FR-188; docs/06 `server_request`, docs/09 §9,
-- contracts/hub-api.md §5, contracts/schemas/server-request.json). All timestamps UTC ISO-8601,
-- ids UUIDv7. A request moves once from `pending` to `resolved` or `expired` (docs/06 invariant
-- 11); a cancelled request (its turn was cancelled) is `expired` as well. Approvals keep their own
-- table: GET /requests lists pending approvals as `kind: 'approval'` items read from `approval`,
-- so no row is written here for them. Correlation ids are plain columns (no foreign keys), so
-- purges and run deletion never block on a request.
CREATE TABLE server_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL
    CHECK (kind IN ('approval', 'user_input', 'elicitation', 'client_tool', 'credential_refresh')),
  thread_id TEXT,
  turn_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  call_id TEXT,
  approval_id TEXT REFERENCES approval (id),
  -- NULL: any authorized client that declared the kind; a client_tool request may name one.
  target_device_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired')),
  -- user | hook:<id>
  resolved_by TEXT,
  resolved_by_device TEXT,
  resolution_json TEXT,
  -- Why an expired request ended: timeout | cancelled | restart.
  expired_reason TEXT,
  -- The fallback notification was sent (FR-060).
  notified_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (status <> 'resolved' OR (resolution_json IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX idx_server_request_pending ON server_request (account_id, expires_at)
  WHERE status = 'pending';
-- The derived thread status (FR-215) looks up pending requests by thread.
CREATE INDEX idx_server_request_thread ON server_request (thread_id) WHERE status = 'pending';
