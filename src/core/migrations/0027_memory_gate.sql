-- The memory gate's consumer (docs/plans/ds2-memory-gate.md NOTES 1–3; docs/plans/track1-follow-up-queue.md,
-- "Memory-gate wiring").
--
-- memory_candidate.reason: why a memory waits for the person when it isn't because the run read
-- outside content. Today that is the memory gate's "flag": what Nova heard conflicts with what it
-- remembers. NULL for every candidate held by the ingest gate, as before.
--
-- decision_record.source: where in Nova a decision was asked, when that isn't a Work Ledger task:
-- the conversation and turn (`<session>/<turn>`) a memory came from. Ids only, never content.
--
-- Neither table is replicated (no sync triggers, as in 0013 and 0019), so nothing else changes.
ALTER TABLE memory_candidate ADD COLUMN reason TEXT;
ALTER TABLE decision_record ADD COLUMN source TEXT;
CREATE INDEX decision_record_source ON decision_record (source);
