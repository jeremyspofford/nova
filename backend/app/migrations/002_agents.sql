-- Migration 002: Agents table

CREATE TABLE IF NOT EXISTS agents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL UNIQUE,
    description      TEXT NOT NULL DEFAULT '',
    system_prompt    TEXT NOT NULL,
    model            TEXT NOT NULL,
    allowed_tools    TEXT[],
    routing_keywords TEXT[],
    enabled          BOOLEAN NOT NULL DEFAULT true,
    is_system        BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agents_enabled_idx ON agents(enabled);

-- Add foreign key constraint if not already there (won't fail if already exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'messages' AND constraint_name = 'messages_agent_fk'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_agent_fk
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  END IF;
END $$;
