-- Migration 032: recommendations — Nova and her automations proactively
-- surface actionable recommendations the operator actually sees, as a card in
-- chat (Approve / Later / Dismiss), instead of quietly writing to a memory
-- topic and hoping to mention it. docs/plans/recommendation-surface.md.
-- Agents RAISE via the raise_recommendation tool; only the operator DECIDES
-- (the decide endpoint is operator-only, never agent-reachable).

CREATE TABLE IF NOT EXISTS recommendations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL,                 -- 'mcp_server' | 'model' | 'action' | 'note' | ...
    title        TEXT NOT NULL,                 -- one line ("Add the GitHub MCP server")
    body         TEXT NOT NULL,                 -- markdown: why + what value it adds
    source       TEXT NOT NULL,                 -- automation/agent that raised it (provenance)
    status       TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','seen','approved','later','dismissed','done')),
    action       JSONB,                         -- optional structured one-click apply (phase 3)
    priority     INT NOT NULL DEFAULT 0,
    dedupe_key   TEXT,                          -- weekly automations set this; re-raise updates
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at   TIMESTAMPTZ,
    decided_by   TEXT
);

-- one live row per dedupe_key: a weekly automation re-raising the same finding
-- updates the existing row instead of stacking duplicates
CREATE UNIQUE INDEX IF NOT EXISTS recommendations_dedupe_idx
    ON recommendations (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS recommendations_status_idx
    ON recommendations (status, priority DESC, created_at DESC);

-- main (the front door) and ingestion (which learns from the web) can RAISE
-- recommendations. Only the operator decides — the decide API is never granted.
UPDATE agents
   SET allowed_tools = array_append(allowed_tools, 'raise_recommendation')
 WHERE name IN ('main', 'ingestion')
   AND allowed_tools IS NOT NULL
   AND NOT ('raise_recommendation' = ANY(allowed_tools));
