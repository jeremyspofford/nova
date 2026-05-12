-- agent-core/app/migrations/002_app_config.sql
-- Generic KV config table. Used by memory-service to lock the embedding dimension
-- after first startup so provider changes can't silently corrupt vector comparisons.

CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
);
