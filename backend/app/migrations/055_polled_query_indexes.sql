-- Indexes for the queries the UI POLLS, and a primary key that was missing.
--
-- Every one of these backs a request that fires on a timer while a panel is
-- open, so the cost is paid over and over rather than once:
--
--   turn_spans(kind)          the observability summary joins turn_spans to
--                             turn_traces filtering kind='llm_call' and
--                             grouping by name — a full scan of the
--                             third-largest table, every 60s.
--   turn_traces(instance_id)  added as a bare column in 046 and then
--                             filtered by three separate queries.
--   monitor_alerts            the alerts endpoint orders the whole table by
--                             (cleared_at IS NOT NULL, raised_at DESC).
--   ingest_jobs               the Ingestion panel sorts by
--                             COALESCE(finished_at, started_at, enqueued_at)
--                             every 8s with no expression index behind it.
--
-- resource_samples had NO primary key at all (046), so nothing structurally
-- prevented duplicate rows from a double-tick or a retried insert.

-- the summary's filter column; partial because 'llm_call' is the only kind
-- it ever asks for, which keeps the index small
CREATE INDEX IF NOT EXISTS idx_turn_spans_llm_call
    ON turn_spans (trace_id) WHERE kind = 'llm_call';

CREATE INDEX IF NOT EXISTS idx_turn_spans_kind_name
    ON turn_spans (kind, name);

CREATE INDEX IF NOT EXISTS idx_turn_traces_instance
    ON turn_traces (instance_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitor_alerts_raised
    ON monitor_alerts (raised_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitor_alerts_open
    ON monitor_alerts (cleared_at, raised_at DESC);

-- matches the ORDER BY expression exactly, so the sort can be an index scan
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_recent
    ON ingest_jobs ((COALESCE(finished_at, started_at, enqueued_at)) DESC);

-- messages: compaction and the UI both filter by role within a conversation,
-- and load_history now takes its row cap over user/assistant only
CREATE INDEX IF NOT EXISTS idx_messages_conv_role_time
    ON messages (conversation_id, role, created_at DESC);

-- resource_samples: dedupe the ledger, then give it a key it can rely on.
-- One sample per instance per timestamp is the intended shape (the sampler
-- self-gates to >=55s), so anything else is a duplicate. Both columns are
-- already NOT NULL, and this DB has zero duplicates today — the DELETE is
-- here for any deployment that drifted before the constraint existed.
DELETE FROM resource_samples a
      USING resource_samples b
      WHERE a.ctid < b.ctid
        AND a.instance_id = b.instance_id
        AND a.ts = b.ts;

-- Catalog check, not an exception handler: adding a second primary key
-- raises invalid_table_definition (42P16), which is NOT the duplicate_object
-- an EXCEPTION block would naturally reach for — caught that the hard way
-- when a re-run failed the migration and the backend refused to start.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'resource_samples_pkey'
                      AND conrelid = 'resource_samples'::regclass) THEN
        ALTER TABLE resource_samples
            ADD CONSTRAINT resource_samples_pkey PRIMARY KEY (instance_id, ts);
    END IF;
END $$;
