-- S10: WHO a turn ran for. Every origin already knows (chat: the caller;
-- a timer: its person; an eval: its scratch person) — recorded so spend can
-- be attributed per person. ON DELETE SET NULL: the money stays on the
-- ledger when a scratch person is torn down; the page says "(no longer
-- exists)" rather than dropping it.
ALTER TABLE turns ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES people (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS turns_person_started ON turns (person_id, started_at DESC);
