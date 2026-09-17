-- S12 agents: an AGENT is a row, not a person. It has no people row — the
-- only two things a people row would buy (a memory partition key and a spend
-- key) are already given to any slash-free string by the memory service and
-- to any ^[a-z_]{1,32}$ role by the gateway's ledger, and a people row would
-- leak a non-person into every person-scoped query (timers, conversations,
-- sessions, the login route). One binding per fact: name → routing role by
-- derivation ('agent_' || name), id → memory partition by derivation.
--
-- The role prefix 'agent_' (6 chars) plus the 26-char name cap is what keeps
-- every derived role inside the gateway's ROLE_RE ^[a-z_]{1,32}$; digits are
-- excluded from names because that pattern has none (the ledger silently
-- NULLs a role that fails it, and a NULL role would drop the agent's spend
-- out of its own cap).
--
-- monthly_cap_usd NULL = uncapped, never 0 (0 is a real cap that refuses).
-- log_conversation_id: the agent's own INACTIVE conversation where delegated
-- tasks and reports land; agents.create inserts it with active = false so
-- conversations.active_conversation(owner) can never pick it (the owner's
-- active chat is the newest ACTIVE row) — a data rule stated here, held by
-- code and a test, not by DDL.
--
-- turns.kind carries no CHECK (002), so the new kind 'agent' needs no DDL.
-- turns.person_id stays the OWNER the work is for (his money); agent_id and
-- role record WHO did the work and which routing role its rounds walked.
-- Nothing here asks anyone for approval (owner ruling 2026-09-03).

CREATE TABLE agents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z_]{0,25}$'),
    purpose            text NOT NULL,
    -- Its own system-prompt block; the shared honesty preamble is Nova's and
    -- is prepended by code, never stored here.
    instructions       text NOT NULL,
    -- The subset of tools.REGISTRY it is advertised. Scope, not permission:
    -- a call outside it still runs and the span says outside_subset.
    tools              text[] NOT NULL,
    -- Names of skill files at <WORKSPACE_ROOT>/skills/<name>.md.
    skills             text[] NOT NULL DEFAULT '{}',
    monthly_cap_usd    numeric(12, 2) CHECK (monthly_cap_usd IS NULL OR monthly_cap_usd >= 0),
    max_tool_rounds    int NOT NULL CHECK (max_tool_rounds BETWEEN 1 AND 50),
    read_shared_memory boolean NOT NULL DEFAULT false,
    log_conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
    created_via        text NOT NULL CHECK (created_via IN ('chat', 'page')),
    -- Provenance: the chat turn whose tool call created it, when there was one.
    created_turn_id    uuid REFERENCES turns (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- WHO did the work (NULL = Nova) and which routing role the rounds walked
-- (NULL = derived from kind, as before). ON DELETE SET NULL: a deleted
-- agent's turns keep their role text in Activity and lose the name.
ALTER TABLE turns ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents (id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS role text;
CREATE INDEX IF NOT EXISTS turns_agent_started
    ON turns (agent_id, started_at DESC) WHERE agent_id IS NOT NULL;

-- A scheduled timer may RUN AS an agent. person_id stays the owner who set
-- it (visibility, cancel, the Schedules page); agent_id says who runs it.
-- ON DELETE RESTRICT is the backstop: agents.delete pauses bound timers with
-- the reason and NULLs agent_id in one transaction before the row goes; any
-- other path that forgets the pause is refused by postgres rather than
-- silently turning the timer into Nova's. Only a 'scheduled' row can be
-- bound — a reminder or a job running as an agent is unrepresentable.
ALTER TABLE timers ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents (id) ON DELETE RESTRICT;
ALTER TABLE timers ADD CONSTRAINT timers_agent_only_scheduled
    CHECK (agent_id IS NULL OR kind = 'scheduled');
