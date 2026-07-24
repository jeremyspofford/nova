-- Migration 050: allow 'eval' as a turn_traces source
-- (docs/plans/model-eval-pipeline.md, phase 1)
--
-- The eval harness runs champion/challenger turns through the same runner as
-- chat and automations, wrapped in trace.turn("eval", ...) so per-round token
-- usage and tool spans land in the ledger. 028's inline CHECK allowed only
-- chat/automation/compaction, and trace._flush swallows insert failures with
-- log.exception (trace.py:220) — so without this widening every eval trace
-- would VANISH silently, leaving nothing but a log line.
--
-- 028 declared the constraint inline and unnamed, so postgres auto-named it
-- turn_traces_source_check. Drop-if-exists then re-add under that same name:
-- idempotent, and the whole file runs in one implicit transaction (asyncpg's
-- simple query protocol), so a failure rolls back and re-runs on next boot.
--
-- Widening only ADDS a permitted value, so every existing row already
-- satisfies the new predicate and the validating scan is a formality.
--
-- The eval_runs / eval_results tables are phase 2, not this migration.

ALTER TABLE turn_traces DROP CONSTRAINT IF EXISTS turn_traces_source_check;
ALTER TABLE turn_traces ADD CONSTRAINT turn_traces_source_check
    CHECK (source IN ('chat', 'automation', 'compaction', 'eval'));
