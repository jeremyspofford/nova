-- last_started and last_error defined in 001_init.sql but absent from DBs
-- that were created before these columns were added to the schema.
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS last_started TIMESTAMPTZ;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS last_error TEXT;
