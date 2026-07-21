-- Migration 031: MCP servers — registry for Model Context Protocol tool
-- servers (docs/plans/mcp-client.md). Operator-registered only; no
-- agent-facing management tool exists on top of this table — an agent that
-- could register a server could grant itself arbitrary capabilities.
--
-- tools_hash is the hash of the LAST APPROVED tool list, not necessarily the
-- current one: a live tool-list change flips status to 'error' and the
-- cache is left untouched until the operator re-approves (tool-description
-- poisoning defense — servers can't silently swap in new instructions).
--
-- command/args (stdio transport) are included now even though the stdio
-- runner sidecar is a later phase, so no further migration is needed for it.

CREATE TABLE IF NOT EXISTS mcp_servers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL UNIQUE,   -- slug; tools namespace as mcp:<name>/<tool>
    transport     TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
    url           TEXT,                          -- http transport
    command       TEXT,                          -- stdio transport, argv[0]
    args          TEXT[] NOT NULL DEFAULT '{}',   -- stdio transport, argv[1:]
    headers       JSONB NOT NULL DEFAULT '{}',    -- http transport, e.g. auth headers
    enabled       BOOLEAN NOT NULL DEFAULT false,
    always_inject BOOLEAN NOT NULL DEFAULT false, -- lazy-loading override (phase 2)
    tools_hash    TEXT,                           -- hash of the last APPROVED tool list
    status        TEXT NOT NULL DEFAULT 'disabled'
                  CHECK (status IN ('connected', 'error', 'disabled')),
    status_detail TEXT,
    last_seen     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cached tools/list results for the last-approved tool set. What
-- get_agent_tools actually serves to agents — never queried live off the
-- hot path of a chat turn.
CREATE TABLE IF NOT EXISTS mcp_tools_cache (
    server_id         UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    parameters_schema JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (server_id, name)
);
