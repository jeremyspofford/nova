-- Migration 072: Cortex watched repos for CI triage (per design §9.6)
-- Idempotent: CREATE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS cortex_watched_repos (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    user_id               UUID,
    credential_id         UUID NOT NULL,                          -- ref to capability_credentials
    repo                  TEXT NOT NULL,                          -- 'jeremyspofford/nova'
    trigger_mode          TEXT NOT NULL DEFAULT 'webhook_with_polling_fallback'
                            CHECK (trigger_mode IN
                                   ('webhook_with_polling_fallback','webhook_only','polling_only')),
    polling_interval_min  INTEGER NOT NULL DEFAULT 15,
    workflow_pattern      TEXT,                                   -- glob; NULL = all
    active_hours_start    TIME,
    active_hours_end      TIME,
    daily_budget          INTEGER NOT NULL DEFAULT 20,
    enabled               BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_repos_unique
    ON cortex_watched_repos(tenant_id, repo);
