-- Migration 003: Tools table (Phase 4)

CREATE TABLE IF NOT EXISTS tools (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL UNIQUE,
    description       TEXT NOT NULL DEFAULT '',
    parameters_schema JSONB NOT NULL DEFAULT '{"type":"object","properties":{}}',
    execution_type    TEXT NOT NULL CHECK (execution_type IN ('http_call','builtin')),
    execution_spec    JSONB NOT NULL DEFAULT '{}',
    enabled           BOOLEAN NOT NULL DEFAULT true,
    is_system         BOOLEAN NOT NULL DEFAULT false,
    created_by_agent  UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_host_allowlist (
    host       TEXT PRIMARY KEY,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tool_host_allowlist (host, note) VALUES
  ('api.open-meteo.com', 'weather demo — no API key required'),
  ('api.github.com', 'GitHub REST API read access')
ON CONFLICT (host) DO NOTHING;
