-- Migration 082: per-agent standby model.
--
-- Until now there was exactly one knob for "what carries a turn when the
-- binding fails": the install-wide inference.local_fallback_model. An agent
-- could not say which model stands behind IT, so a specialist with fourteen
-- tools and the voice agent with two shared one answer.
--
-- A self-referential fallback is meaningless (retrying the model that just
-- failed, on the same failure), so it is blanked — by a TRIGGER, not a
-- CHECK. A CHECK fires on every path that repoints a model: the bulk "set
-- all agents to this model" button, the in-chat model picker, the
-- recommendation Apply, manage_agents, and any future model-repointing
-- migration. Each of those would start raising on rows it never meant to
-- touch, and patch_agent_endpoint has no exception path for it — the
-- operator would get a plain-text 500 the frontend cannot parse, for
-- pressing a button about a DIFFERENT field. The trigger makes the same
-- invariant true without ever refusing a write.
--
-- Comparison is on the stored binding, not the resolved one: resolution
-- depends on which providers are configured right now, which is not a fact
-- the database has or should have.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS fallback_model TEXT;

CREATE OR REPLACE FUNCTION agents_blank_self_fallback() RETURNS trigger AS $$
BEGIN
  IF NEW.fallback_model IS NOT NULL THEN
    IF btrim(NEW.fallback_model) = '' THEN
      NEW.fallback_model := NULL;
    ELSIF btrim(NEW.fallback_model) = btrim(coalesce(NEW.model, '')) THEN
      -- not an error: the operator moved the model onto its own standby,
      -- which simply means there is no standby any more
      NEW.fallback_model := NULL;
    ELSE
      NEW.fallback_model := btrim(NEW.fallback_model);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_blank_self_fallback ON agents;
CREATE TRIGGER agents_blank_self_fallback
  BEFORE INSERT OR UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_blank_self_fallback();

COMMENT ON COLUMN agents.fallback_model IS
  'Operator-chosen standby for this agent when its own model fails before the first byte. NULL = fall through to inference.local_fallback_model, then the main agent''s model. Never settable from a chat turn.';
