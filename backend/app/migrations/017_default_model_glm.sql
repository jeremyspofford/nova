-- Default cloud model: anthropic/claude-haiku-4.5 -> z-ai/glm-5.2.
-- Cheaper ($0.93/$2.92 vs $1/$5 per M tokens), 1M context, tools + parallel
-- tool calls verified on OpenRouter 2026-07-14. Also sweeps the stale
-- claude-3.5-haiku (news-summarizer). Local (ollama:*) agents untouched.

UPDATE agents
SET model = 'openrouter:z-ai/glm-5.2', updated_at = now()
WHERE model IN ('openrouter:anthropic/claude-haiku-4.5',
                'openrouter:anthropic/claude-3.5-haiku');
