-- Phase 3 of docs/plans/secrets-management.md: sources other than the
-- built-in store, behind one resolver seam.
--
-- The principle from [[nova-identity-decisions]] holds: REFERENCE, DON'T
-- MIRROR. An external secret's value never enters Nova's database — only the
-- pointer does, and Nova asks the holder at call time. The `ref` column and
-- the CHECK that forbids a value alongside it were already in migration 072
-- for exactly this.
--
-- Two sources are added that need no new binary and can therefore be verified
-- here: `file` (a path — Docker secrets, Kubernetes secret mounts, anything
-- mounted at runtime) and `env` (a variable, for bootstrap and CI). The
-- CLI-backed managers named in the plan (1Password, Bitwarden/Vaultwarden)
-- were already in the CHECK from 072 and stay there; what they still need is
-- an infrastructure decision, not a schema change.
ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_source_check;
ALTER TABLE secrets ADD CONSTRAINT secrets_source_check
    CHECK (source IN ('builtin', 'file', 'env',
                      '1password', 'bitwarden', 'vaultwarden'));
