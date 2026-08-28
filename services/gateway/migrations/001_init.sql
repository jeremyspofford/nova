-- Bootstrap migration. The runner creates schema_migrations itself if
-- absent; this file just needs one no-op-safe statement so empty->N is
-- exercised on a fresh database.
CREATE SCHEMA IF NOT EXISTS app;
