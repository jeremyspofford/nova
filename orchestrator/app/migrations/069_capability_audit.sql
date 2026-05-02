-- Capability platform: tamper-evident audit log
-- See docs/designs/2026-05-01-nova-capability-platform-design.md §8

CREATE TABLE IF NOT EXISTS capability_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

    actor_kind      TEXT NOT NULL CHECK (actor_kind IN
                       ('agent','human','cortex_drive','cron','webhook','system')),
    actor_id        TEXT NOT NULL,
    task_id         UUID,

    event_type      TEXT NOT NULL CHECK (event_type IN
                       ('tool_call','consent_request','consent_decision',
                        'credential_use','mcp_register','tier_override',
                        'rule_apply','budget_exceeded')),
    tool_name       TEXT,
    tool_kind       TEXT CHECK (tool_kind IN ('native','mcp_http','mcp_stdio')),
    blast_radius    TEXT,

    provider_kind   TEXT,
    target          TEXT,
    credential_id   UUID,

    args_redacted   JSONB,
    response_status TEXT NOT NULL CHECK (response_status IN
                       ('success','rejected','error','rate_limited','timeout','pending')),
    response_summary TEXT,
    error_class     TEXT,
    duration_ms     INTEGER,

    prev_hash       BYTEA NOT NULL,
    content_hash    BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time
    ON capability_audit(tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_task
    ON capability_audit(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_target ON capability_audit(target);
CREATE INDEX IF NOT EXISTS idx_audit_credential
    ON capability_audit(credential_id) WHERE credential_id IS NOT NULL;

-- Append-only enforcement: silently reject UPDATE and DELETE from app code
CREATE OR REPLACE RULE capability_audit_no_update AS
  ON UPDATE TO capability_audit DO INSTEAD NOTHING;
CREATE OR REPLACE RULE capability_audit_no_delete AS
  ON DELETE TO capability_audit DO INSTEAD NOTHING;
