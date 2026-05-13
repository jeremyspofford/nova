-- mcp_servers.working_dir was defined in 001_init.sql but existed DBs are missing it
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS working_dir TEXT;
