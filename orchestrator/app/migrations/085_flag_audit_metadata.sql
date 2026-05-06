-- Feature flags v1, A4: capture request metadata in audit log.
--
-- The shared X-Admin-Secret in v1 means actor='admin' is a useless string for
-- forensics. Adding actor_ip / actor_user_agent / request_id gives operators
-- something to pivot on during incident response, even before per-user RBAC
-- arrives in Phase 2.
--
-- All three columns are NULLABLE: pre-existing rows from migration 083 don't
-- have request context, and tests that insert directly via psql shouldn't be
-- forced to fabricate values.

ALTER TABLE feature_flag_audit
    ADD COLUMN IF NOT EXISTS actor_ip         INET,
    ADD COLUMN IF NOT EXISTS actor_user_agent TEXT,
    ADD COLUMN IF NOT EXISTS request_id       UUID;
