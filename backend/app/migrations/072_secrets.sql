-- A place for the tokens Nova's integrations need — encrypted, referenced by
-- name, resolved only at the outbound call. docs/plans/secrets-management.md
-- phase 1, architecture LOCKED by Jeremy 2026-07-24: built-in store first,
-- external managers stay a later opt-in.
--
-- The concrete gap this closes: `mcp_servers.headers` is JSONB and holds
-- whatever the operator typed, so a GitHub token registered today sits in
-- plaintext in Postgres and goes straight to the client. After this, the
-- stored header holds `Bearer {{secret:github_pat}}` and the value lives
-- encrypted in one place.
--
-- `value_enc` is bytea and NULLABLE because a later external source (1Password,
-- Vaultwarden) stores a REFERENCE and never the value — "reference, don't
-- mirror", the decision from [[nova-identity-decisions]]. `source` is here from
-- the start so phase 3 needs no migration of existing rows.
--
-- No `value` column in any form, and no plaintext fallback: a schema that CAN
-- hold a bare secret eventually will.

CREATE TABLE IF NOT EXISTS secrets (
    name         text PRIMARY KEY,
    source       text NOT NULL DEFAULT 'builtin'
                 CHECK (source IN ('builtin', '1password', 'bitwarden', 'vaultwarden')),
    -- builtin: AES-GCM ciphertext (nonce prepended). NULL for external sources.
    value_enc    bytea,
    -- external: the manager's own reference, e.g. 'op://Private/GitHub/token'
    ref          text,
    description  text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    -- so the UI can say "last used 3 days ago", and so a secret nothing has
    -- ever resolved is visible as the dead weight it probably is
    last_used_at timestamptz,
    -- exactly one of the two must be present for the row to be resolvable
    CONSTRAINT secrets_has_a_value CHECK (
        (source = 'builtin' AND value_enc IS NOT NULL AND ref IS NULL)
        OR (source <> 'builtin' AND ref IS NOT NULL AND value_enc IS NULL))
);
