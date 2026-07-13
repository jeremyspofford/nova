-- Migration 005: point seeded agents at a current OpenRouter model
-- (anthropic/claude-3.5-haiku is stale; claude-haiku-4.5 verified live, tools-capable)

UPDATE agents
SET model = 'openrouter:anthropic/claude-haiku-4.5', updated_at = now()
WHERE model = 'openrouter:anthropic/claude-3.5-haiku';
