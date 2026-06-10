-- agent-core/app/migrations/001_init.sql

-- Enable pgvector (memory-service will use this)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tasks (materialized head for fast query)
CREATE TABLE IF NOT EXISTS tasks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    source       TEXT NOT NULL DEFAULT 'user',
    parent_task_id UUID REFERENCES tasks(id),
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Task events (append-only, hash-chained audit log)
CREATE TABLE IF NOT EXISTS task_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL REFERENCES tasks(id),
    type         TEXT NOT NULL,
    payload      JSONB NOT NULL DEFAULT '{}',
    hash         TEXT NOT NULL DEFAULT '',
    prev_hash    TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events (task_id);

-- Secrets (AES-256-GCM at rest)
CREATE TABLE IF NOT EXISTS secrets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT UNIQUE NOT NULL,
    ciphertext   BYTEA NOT NULL,
    nonce        BYTEA NOT NULL,
    purpose      TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now(),
    last_used    TIMESTAMPTZ,
    used_count   INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets (name);

-- Memories (pgvector — dimension set by memory-service on first embed)
CREATE TABLE IF NOT EXISTS memories (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content      TEXT NOT NULL,
    embedding    vector(768),
    source_kind  TEXT NOT NULL,
    source_uri   TEXT,
    tags         TEXT[] DEFAULT '{}',
    created_at   TIMESTAMPTZ DEFAULT now(),
    used_count   INT DEFAULT 0,
    last_used    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_memories_source_kind ON memories (source_kind);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags);

-- Schedules
CREATE TABLE IF NOT EXISTS schedules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    trigger      JSONB NOT NULL,
    enabled      BOOL DEFAULT true,
    created_by   TEXT NOT NULL DEFAULT 'user',
    created_at   TIMESTAMPTZ DEFAULT now(),
    last_fired   TIMESTAMPTZ,
    next_fire    TIMESTAMPTZ,
    fire_count   INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_schedules_next_fire
    ON schedules (next_fire) WHERE enabled = true AND next_fire IS NOT NULL;

-- MCP servers
CREATE TABLE IF NOT EXISTS mcp_servers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT UNIQUE NOT NULL,
    command      TEXT NOT NULL,
    args         JSONB NOT NULL DEFAULT '[]'::jsonb,
    env          JSONB DEFAULT '{}',
    working_dir  TEXT,
    enabled      BOOL DEFAULT true,
    created_at   TIMESTAMPTZ DEFAULT now(),
    last_started TIMESTAMPTZ,
    last_error   TEXT
);

CREATE TABLE IF NOT EXISTS mcp_tool_overrides (
    mcp_server_id UUID REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name     TEXT NOT NULL,
    tier_override TEXT,
    PRIMARY KEY (mcp_server_id, tool_name)
);
