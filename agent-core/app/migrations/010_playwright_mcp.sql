-- Migration 010: Seed Playwright MCP server for browser automation.
-- Inserts only if the record doesn't exist — safe to re-run.
-- transport defaults to 'stdio' (migration 006 set DEFAULT 'stdio').
-- The boot_mcp_servers() function picks this up at next agent-core startup.
INSERT INTO mcp_servers (name, command, args, enabled)
VALUES (
    'playwright',
    'npx',
    '["@playwright/mcp", "--headless"]'::jsonb,
    true
)
ON CONFLICT (name) DO NOTHING;
