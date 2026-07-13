-- A crashed agent is not reviewable work. on_failure='escalate' routed agent
-- crashes into the human-review queue as pending_human_review noise; the only
-- sane responses to a crash are abort (task → failed) or skip. Genuine
-- quality escalations (guardrail verdicts, critique rounds exhausted) still
-- go to review — this only removes the crash path.
UPDATE pod_agents SET on_failure = 'abort' WHERE on_failure = 'escalate';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pod_agents_on_failure_check'
    ) THEN
        ALTER TABLE pod_agents
            ADD CONSTRAINT pod_agents_on_failure_check
            CHECK (on_failure IN ('abort', 'skip'));
    END IF;
END $$;
