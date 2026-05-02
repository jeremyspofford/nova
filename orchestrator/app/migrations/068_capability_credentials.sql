-- Capability platform: credentials for third-party systems (GitHub, Cloudflare, AWS, ...)
-- See docs/designs/2026-05-01-nova-capability-platform-design.md §6

CREATE TABLE IF NOT EXISTS capability_credentials (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    user_id           UUID,
    provider_kind     TEXT NOT NULL,
    auth_method       TEXT NOT NULL CHECK (auth_method IN ('pat','github_app','oauth')),
    label             TEXT NOT NULL,
    backend           TEXT NOT NULL DEFAULT 'builtin'
                        CHECK (backend IN ('builtin','vault','onepassword','bitwarden')),
    encrypted_data    BYTEA,
    external_ref      TEXT,
    key_version       INTEGER NOT NULL DEFAULT 1,
    scopes            JSONB,
    expires_at        TIMESTAMPTZ,
    last_validated_at TIMESTAMPTZ,
    health            TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (health IN ('healthy','expired','revoked','invalid','unknown')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cap_creds_tenant ON capability_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cap_creds_kind ON capability_credentials(tenant_id, provider_kind);

CREATE TABLE IF NOT EXISTS capability_credential_audit (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id UUID NOT NULL REFERENCES capability_credentials(id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL,
    action        TEXT NOT NULL CHECK (action IN
                    ('store','retrieve','rotate','delete','validate','use')),
    actor         TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
    success       BOOLEAN NOT NULL DEFAULT true,
    detail        TEXT
);

CREATE INDEX IF NOT EXISTS idx_cap_cred_audit_cred
    ON capability_credential_audit(credential_id);
