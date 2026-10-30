-- Signed session requests already used (mesh/devices.ts startSession). Each starts one session
-- only; kept in memory before, so a restart let one be replayed while its time was still fresh.
-- A row is kept until its time is too old to be fresh anyway. Never replicated: like
-- device_session, it is about this node's own sessions.
CREATE TABLE session_signature (
  device_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  until TEXT NOT NULL,
  PRIMARY KEY (device_id, time)
);
CREATE INDEX session_signature_until ON session_signature (until);
