-- Human checkpoints (task #8 milestone B)
-- approval_requests doubles as the queue for mid-task human checkpoints:
-- an agent calls request_human_checkpoint, the task parks in waiting_human,
-- and the operator's decision (+ free-text reply) resumes it.

-- kind discriminates consent-gate approvals (re-execute the pended tool on
-- approve) from checkpoints (resume the parked task on approve OR reject).
ALTER TABLE approval_requests
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'consent'
        CHECK (kind IN ('consent', 'checkpoint'));

-- The operator's free-text reply captured at decide time (verification codes,
-- instructions, decline reasons). Injected into the parked task as the
-- checkpoint tool's result.
ALTER TABLE approval_requests
    ADD COLUMN IF NOT EXISTS response_text TEXT;

-- Checkpoints are not mutations — they ask a question. Allow 'propose'.
ALTER TABLE approval_requests
    DROP CONSTRAINT IF EXISTS approval_requests_blast_radius_check;
ALTER TABLE approval_requests
    ADD CONSTRAINT approval_requests_blast_radius_check
        CHECK (blast_radius IN ('propose', 'mutate', 'destruct'));
