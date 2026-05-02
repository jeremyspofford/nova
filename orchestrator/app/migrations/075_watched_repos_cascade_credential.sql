-- Migration 075: ON DELETE CASCADE on cortex_watched_repos.credential_id
--
-- Migration 072 created cortex_watched_repos with credential_id NOT NULL but
-- without an enforced FK to capability_credentials(id). Deleting a credential
-- left orphan watched_repos that the cortex drive would still see — fragile.
-- This migration cleans up any existing orphans (none on a fresh install) and
-- adds the FK with CASCADE so credential deletion atomically removes the
-- attached triage configurations.
--
-- Idempotent via pg_constraint guard.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cortex_watched_repos_credential_id_fkey'
      AND conrelid = 'cortex_watched_repos'::regclass
  ) THEN
    -- Remove any orphans before adding the constraint, otherwise the
    -- constraint addition will fail with a "violates foreign key" error.
    DELETE FROM cortex_watched_repos
     WHERE credential_id NOT IN (SELECT id FROM capability_credentials);

    ALTER TABLE cortex_watched_repos
      ADD CONSTRAINT cortex_watched_repos_credential_id_fkey
      FOREIGN KEY (credential_id)
      REFERENCES capability_credentials(id)
      ON DELETE CASCADE;
  END IF;
END $$;
