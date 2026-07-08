-- Hard user deletion (DELETE /api/v1/admin/users/{id}).
-- These four references used NO ACTION, which blocked deleting any user who
-- had created a tenant or an invite, redeemed an invite, or appeared as an
-- RBAC audit actor. History rows now survive with a NULL user reference.
-- (conversations and refresh_tokens already CASCADE; tasks, friction_log,
-- and platform_config_audit already SET NULL.)

ALTER TABLE invite_codes ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE invite_codes
    DROP CONSTRAINT IF EXISTS invite_codes_created_by_fkey,
    ADD CONSTRAINT invite_codes_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE invite_codes
    DROP CONSTRAINT IF EXISTS invite_codes_used_by_fkey,
    ADD CONSTRAINT invite_codes_used_by_fkey
        FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE rbac_audit_log
    DROP CONSTRAINT IF EXISTS rbac_audit_log_actor_id_fkey,
    ADD CONSTRAINT rbac_audit_log_actor_id_fkey
        FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_created_by_fkey,
    ADD CONSTRAINT tenants_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
