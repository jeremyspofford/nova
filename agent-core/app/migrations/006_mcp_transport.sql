-- Migration 006: MCP transport column guard + tool overrides index
-- transport column was added idempotently in 004_tasks_audit.sql;
-- this migration adds the missing index on mcp_tool_overrides.

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'stdio';

CREATE INDEX IF NOT EXISTS idx_mcp_tool_overrides_server ON mcp_tool_overrides (mcp_server_id);
