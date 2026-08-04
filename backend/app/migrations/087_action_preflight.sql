-- Recommendation actions, phase 1: the network's verdict on a card's plan.
--
-- The `action jsonb` column has existed since migration 032 ("optional
-- structured one-click apply (phase 3)") and in the years since has been
-- written by nobody and read by nobody. It now carries a TYPED PLAN
-- (app/actions/schemas.py). These three columns are what the backend found
-- when it checked that plan against reality, recorded BEFORE the operator
-- ever sees the card — so a model that is confidently wrong about an
-- endpoint is refuted on the card rather than believed.

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS action_state text NOT NULL DEFAULT 'none'
    CHECK (action_state IN ('none', 'ready', 'blocked')),
  ADD COLUMN IF NOT EXISTS action_detail text,
  ADD COLUMN IF NOT EXISTS action_checked_at timestamptz;

-- Provenance for the MCP registry, so the outbound guard can be DERIVED
-- rather than driven by a host list somebody maintains.
--
-- The operator is allowed to register http://homeassistant.local — that is
-- his LAN and his decision. A server that arrived via an approved
-- recommendation is not allowed to name a private address, and not only at
-- registration: tools/registry refreshes every server on a 15-minute timer,
-- so a hostname that resolved public once and resolves internal later would
-- otherwise be dialled forever. mcp_client checks this column on every
-- connect and every call.
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT 'operator';
