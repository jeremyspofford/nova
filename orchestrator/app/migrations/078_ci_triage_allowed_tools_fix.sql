-- Migration 078: Fix ci_triage_agent Task Agent allowed_tools phantom names.
--
-- Closes G3 from docs/audits/2026-05-03-readiness-assessment.md. Migration
-- 073 seeded the Task Agent with `get_run_details` and `get_check_runs` —
-- neither name exists in app/tools/github_external_tools.py. The dispatcher
-- returns "Unknown tool" for both, costing the agent a turn per call. The
-- correct names are `get_workflow_run` and `get_run_logs`.
--
-- Idempotent: array_replace is a no-op when the search value is absent, so
-- this migration can be re-applied safely (and double-applied across
-- concurrent init_db calls — the schema_migrations table already prevents
-- that, but the operation itself is also a no-op).

UPDATE pod_agents
SET allowed_tools = array_replace(
    array_replace(allowed_tools, 'get_run_details', 'get_workflow_run'),
    'get_check_runs', 'get_run_logs'
)
WHERE pod_id = (SELECT id FROM pods WHERE name = 'ci_triage_agent')
  AND role = 'task';
