-- S37a: the MCP servers she can use (docs/plans/rebuild/s37a/spec.md §2).
--
-- One row per server, added on Settings → Connections or by her with
-- mcp_connect; app/mcp/servers.py's connect() is the only writer, and it
-- saves a row only after the server answered. Nothing here is a permission
-- (owner ruling 2026-09-03): a row is an address, its credentials, and what
-- the server said it offers — never a grant.
--
-- `token` and the VALUES of `headers` are credentials. The store writes them
-- and only the client reads them, to make a call; no route or tool returns
-- them (routes return has_token and header NAMES). They sit in plaintext like
-- the gateway's provider keys, by the owner's choice of 2026-09-30, until the
-- encrypted store (doing-things Q6) takes both. S41's backup bundle is
-- encrypted, so a backup does not expose them.
--
-- `tools` is the server's own list as last read — names, descriptions, input
-- schemas — so the line in her prompt needs no network call.
--
-- No added_turn_id: a tool cannot name its turn (ToolContext carries no turn
-- id, and its field set is pinned). Provenance is the mcp_connect span and
-- the governance event (plan decision P7).

CREATE TABLE mcp_servers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The name she calls it by in mcp_call; app/mcp/servers.py's NAME_RE.
    name             text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
    url              text NOT NULL CHECK (url ~ '^https?://[^/?#]+'),
    token            text,
    headers          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'),
    added_by         text NOT NULL CHECK (added_by IN ('owner', 'nova')),
    -- '2026-07-28' or 'legacy:<version>', as the last probe found it; for
    -- display (the client finds the era once per process — plan decision P3).
    protocol         text,
    title            text,
    tools            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools) = 'array'),
    tools_hash       text,
    tools_fetched_at timestamptz,
    tools_ttl_ms     bigint CHECK (tools_ttl_ms IS NULL OR tools_ttl_ms >= 0),
    tools_changed_at timestamptz,
    last_ok_at       timestamptz,
    last_error       text,
    last_error_at    timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
