-- Migration 114: 'heartbeat' is a turn source the ledger recognises.
--
-- Migration 113 gave the heartbeat its own trace source so a beat can
-- never read as the operator's turn — and the traces CHECK (050) would
-- have refused the very first insert, crashing the first beat minutes
-- after it was seeded. Caught before it fired, this time by looking; the
-- lasting fix is test_heartbeat's registration check plus this row in the
-- registry the constraint IS.
--
-- Its own migration rather than an edit to 113, because 113 has already
-- applied here and an applied migration is never re-run (db.py's
-- edited-after-apply warning exists for exactly that silent no-op).

ALTER TABLE turn_traces DROP CONSTRAINT IF EXISTS turn_traces_source_check;
ALTER TABLE turn_traces ADD CONSTRAINT turn_traces_source_check
    CHECK (source IN ('chat', 'automation', 'compaction', 'eval',
                      'heartbeat'));
