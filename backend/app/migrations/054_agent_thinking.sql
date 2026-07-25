-- Migration 054: per-agent control over a reasoning model's thinking.
--
-- Measured 2026-07-24: qwen3 models on this ollama think by DEFAULT, and
-- Nova never asked them to. A "say hello in three words" prompt streamed
-- 3,016 characters of reasoning, and the client reads only delta.content —
-- so the tokens were paid for and discarded. The voice model is one of
-- these, which means the most latency-sensitive path in the product has
-- been reasoning before every spoken reply.
--
-- 'auto' preserves exactly that behavior (send nothing, let the model do
-- what it does), so this migration changes no behavior on its own. 'on'
-- and 'off' take control, and only for models the SERVER reports as
-- thinking-capable — capability is asked at runtime via ollama's
-- /api/show, never inferred from a model name. Nothing in Nova knows
-- which models reason.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS thinking TEXT NOT NULL DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_thinking_check') THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_thinking_check CHECK (thinking IN ('auto', 'on', 'off'));
  END IF;
END $$;

COMMENT ON COLUMN agents.thinking IS
  'auto = whatever the model does by default; on/off = force it, for models the inference server reports as thinking-capable.';
