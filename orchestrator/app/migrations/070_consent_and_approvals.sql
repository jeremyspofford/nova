-- Capability platform: approval queue and consent rules
-- See docs/designs/2026-05-01-nova-capability-platform-design.md §7.4

CREATE TABLE IF NOT EXISTS approval_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    task_id         UUID,
    requested_by    TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    tool_kind       TEXT NOT NULL CHECK (tool_kind IN ('native','mcp_http','mcp_stdio')),
    blast_radius    TEXT NOT NULL CHECK (blast_radius IN ('mutate','destruct')),
    args_redacted   JSONB NOT NULL,
    diff_preview    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','timeout','superseded')),
    decided_by      TEXT,
    decided_via     TEXT,
    decided_at      TIMESTAMPTZ,
    rule_id         UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_approval_pending
    ON approval_requests(tenant_id, status, expires_at)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS consent_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID NOT NULL,
    tool_name       TEXT NOT NULL,
    provider_kind   TEXT NOT NULL,
    scope_match     JSONB NOT NULL,
    source          TEXT NOT NULL CHECK (source IN ('user_remember','cortex_proposed')),
    proposed_at     TIMESTAMPTZ,
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_applied_at TIMESTAMPTZ,
    apply_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_consent_rules_lookup
    ON consent_rules(tenant_id, user_id, tool_name) WHERE enabled = true;
