-- Migration 013: Automations — schedule + instruction + executing agent.
-- One generic scheduler; the staleness sweep is just seeded automation #1.

CREATE TABLE IF NOT EXISTS automations (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL UNIQUE,
    description          TEXT NOT NULL DEFAULT '',
    instruction          TEXT NOT NULL,
    agent_name           TEXT NOT NULL,
    interval_minutes     INTEGER NOT NULL CHECK (interval_minutes >= 5),
    enabled              BOOLEAN NOT NULL DEFAULT true,
    is_system            BOOLEAN NOT NULL DEFAULT false,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_run_at          TIMESTAMPTZ,
    next_run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_status          TEXT,
    last_summary         TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO automations (name, description, instruction, agent_name, interval_minutes, is_system, next_run_at)
VALUES (
  'refresh-stale-knowledge',
  'Keeps sourced memory topics current by re-ingesting them when they age past the staleness threshold.',
  'Call list_stale_topics. If it returns nothing, reply "nothing stale" and stop. Otherwise refresh up to 3 of the OLDEST topics using your REFRESH workflow: read_memory_item to get each topic''s content and source_url, re-fetch the source, and write_memory WITH item_id so the topic updates in place. If a topic''s source repeatedly fails to fetch, update the topic (item_id) adding a note that the source appears dead — that removes it from the stale list. Finish with a short report of what you refreshed and what changed.',
  'ingestion',
  360,
  true,
  now() + interval '10 minutes'
)
ON CONFLICT (name) DO NOTHING;

-- ingestion gets the mechanical staleness scanner; main gets automation CRUD
UPDATE agents SET allowed_tools = array_append(allowed_tools, 'list_stale_topics'), updated_at = now()
WHERE name = 'ingestion' AND NOT ('list_stale_topics' = ANY(allowed_tools));

UPDATE agents SET allowed_tools = array_append(allowed_tools, 'manage_automations'), updated_at = now()
WHERE name = 'main' AND NOT ('manage_automations' = ANY(allowed_tools));
