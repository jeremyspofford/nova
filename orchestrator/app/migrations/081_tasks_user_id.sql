-- 081_tasks_user_id.sql
-- T2-01: Resolve tenant_id from auth context.
--
-- The pipeline executor needs to resolve a task's owning user so that
-- credential lookups, consent gating, and audit attribution all run under
-- that user's tenant rather than a hardcoded DEFAULT_USER. Adding the
-- column is additive — historical tasks remain NULL and the executor
-- falls back to the seeded tenant.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_id
  ON tasks (user_id) WHERE user_id IS NOT NULL;
