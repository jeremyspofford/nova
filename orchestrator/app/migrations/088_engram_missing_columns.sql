-- 088_engram_missing_columns.sql
-- Restore three columns on `engrams` that app code references but the live
-- DB was missing: `source_meta`, `temporal_validity`, `valid_as_of`.
--
-- Background: memory-service/app/db/schema.sql declares these as idempotent
-- `DO $$ ... ALTER TABLE engrams ADD COLUMN ... $$;` blocks run at startup.
-- But run_schema_migrations()'s DO-block extractor consumes the trailing `;`
-- of each block, so when several DO blocks appear consecutively they collapse
-- into one split-chunk and only the FIRST is dispatched. The run of four
-- adjacent blocks (source_ref_id, source_meta, temporal_validity, valid_as_of)
-- therefore applied only source_ref_id; the other three were silently dropped
-- (the runner still logged "Schema migrations applied").
--
-- Impact: GET /api/v1/engrams/user-profile returned 500
-- (`column "source_meta" does not exist`), and engram ingestion's INSERT
-- silently failed on `source_meta` / `temporal_validity` (queued 201, then the
-- worker INSERT raised and the row was never persisted).
--
-- This migration realizes the columns directly via the orchestrator's
-- tracked migration runner (which uses a proper dollar-quote-aware tokenizer).
-- It is idempotent (IF NOT EXISTS) and additive, so it is safe alongside the
-- memory-service schema.sql DO blocks, which no-op on duplicate_column.

ALTER TABLE engrams
  ADD COLUMN IF NOT EXISTS source_meta      JSONB      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS temporal_validity TEXT       DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS valid_as_of       TIMESTAMPTZ;
