-- 099_ingestion_sources.sql
-- External ingestion sources: registered apps that push via POST /api/v1/ingest.
-- Replaces the per-source bridge pattern (screenpipe-bridge removed 2026-07-06):
-- one authenticated HTTP endpoint for every source instead of a service each.
-- See docs/superpowers/plans/2026-07-06-generalized-ingestion-endpoint.md.

CREATE TABLE IF NOT EXISTS ingestion_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,              -- human label, e.g. "desktop-capture", "meeting-exporter"
    source_type TEXT NOT NULL,              -- maps to memory source_type / nova_source_kind
    trust DOUBLE PRECISION NOT NULL DEFAULT 0.70,
    api_key_hash TEXT,                      -- SHA-256 of the per-source token (NULL = operator-credential pushes only)
    rate_limit_per_minute INT NOT NULL DEFAULT 120,
    denylist_apps JSONB NOT NULL DEFAULT '[]'::jsonb,
    denylist_url_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    denylist_window_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_ingested_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingestion_sources_active ON ingestion_sources (active) WHERE active;
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_key ON ingestion_sources (api_key_hash) WHERE api_key_hash IS NOT NULL;
