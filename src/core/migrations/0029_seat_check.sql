-- Seat health (design amendment 2026-11-12, "Authentication and seat health"; src/core/claude-seat.ts).
--
-- seat_check: every check of a model seat, newest last: a keepalive probe, a probe after a sign-in,
-- one the person asked for, or a live call that failed to authenticate (by = 'call'). state is one
-- of ok, needs-sign-in, unreachable; said is what was seen, in plain words, never a sign-in page's
-- address or code. Health reads the newest; the seat's problem closes only on an ok probe newer
-- than it, and the Work Ledger task that records the closing cites the probe's id as evidence.
--
-- Not replicated (no sync triggers, as in 0013 and 0019): a seat's sign-in belongs to the machine
-- that holds it, and a standby keeps its own.
CREATE TABLE seat_check (
  id INTEGER PRIMARY KEY,
  seat TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'needs-sign-in', 'unreachable')),
  by TEXT NOT NULL,
  said TEXT NOT NULL
);
CREATE INDEX seat_check_seat ON seat_check (seat, id);
