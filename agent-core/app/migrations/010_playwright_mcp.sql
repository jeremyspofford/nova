-- Migration 010: Seed Playwright MCP server for browser automation.
-- Inserts only if the record doesn't exist — safe to re-run.
-- transport defaults to 'stdio' (migration 006 set DEFAULT 'stdio').
-- The boot_mcp_servers() function picks this up at next agent-core startup.

-- Heal databases created by the original 001_init.sql, which declared args as
-- TEXT[] while all application code (and the INSERT below) expects JSONB.
-- Fresh installs crashed here on first boot, so for them this migration is
-- still pending and this conversion runs before the INSERT.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'mcp_servers' AND column_name = 'args' AND data_type = 'ARRAY'
    ) THEN
        ALTER TABLE mcp_servers ALTER COLUMN args DROP DEFAULT;
        ALTER TABLE mcp_servers ALTER COLUMN args TYPE jsonb USING to_jsonb(args);
        ALTER TABLE mcp_servers ALTER COLUMN args SET DEFAULT '[]'::jsonb;
    END IF;
END $$;

INSERT INTO mcp_servers (name, command, args, enabled)
VALUES (
    'playwright',
    'npx',
    '["@playwright/mcp", "--headless"]'::jsonb,
    true
)
ON CONFLICT (name) DO NOTHING;
