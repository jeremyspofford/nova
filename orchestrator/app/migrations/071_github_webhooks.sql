-- Capability platform: GitHub webhook tracking (per design §9.1.1)

CREATE TABLE IF NOT EXISTS github_webhooks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    credential_id    UUID NOT NULL REFERENCES capability_credentials(id),
    repo             TEXT NOT NULL,
    hook_id          BIGINT NOT NULL,
    target_url       TEXT NOT NULL,
    encrypted_secret BYTEA NOT NULL,
    events           TEXT[] NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','active','verified','failed','revoked')),
    last_event_at    TIMESTAMPTZ,
    last_pinged_at   TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_webhooks_repo
    ON github_webhooks(tenant_id, repo);
