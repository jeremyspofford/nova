-- agent-core/app/migrations/004_tasks_audit.sql
-- Idempotent: all statements guarded with IF NOT EXISTS or ADD COLUMN IF NOT EXISTS.

-- Extend tasks table (Plan 0 created minimal columns)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS goal TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Extend task_events for v2 audit chain (old columns kept for compat)
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT '';
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS chain_hash TEXT DEFAULT '';
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS task_events_task_id_event_type ON task_events(task_id, occurred_at);

-- Extend mcp_servers with transport column
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'stdio';

-- Approval requests (MUTATE/DESTRUCT consent)
CREATE TABLE IF NOT EXISTS approvals (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tool_call_id UUID,
    tool_name    TEXT NOT NULL,
    scope        TEXT NOT NULL,
    args         JSONB NOT NULL DEFAULT '{}',
    tier         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'granted', 'denied', 'expired')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS approvals_task_id ON approvals(task_id);

-- MCP tool catalog
CREATE TABLE IF NOT EXISTS mcp_tools (
    server_id     UUID REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name     TEXT NOT NULL,
    tier_auto     TEXT NOT NULL,
    tier_override TEXT,
    enabled       BOOL DEFAULT true,
    schema_cache  JSONB DEFAULT '{}',
    PRIMARY KEY (server_id, tool_name)
);
