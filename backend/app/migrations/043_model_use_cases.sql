-- Migration 043: use-case tags for curated models — "what is this model good
-- for", as a filterable controlled vocabulary (distinct from `roles`, which are
-- Nova's internal agent profiles). Powers the use-case filter and the per-model
-- "good for" chips in Settings → Models.
--
-- Vocabulary (curated_models._USE_CASES): coding, agentic-tools, reasoning,
-- writing, chat, vision, long-context, multilingual, summarization.
-- Rough editorial judgment for the default quantization — the probe stays the
-- truth for tool/agentic capability; these tags are about task fit.

ALTER TABLE curated_models
    ADD COLUMN IF NOT EXISTS use_cases TEXT[] NOT NULL DEFAULT '{}';

-- Seed the shipped rows. Kept honest: vision only where the model actually
-- takes image input (Claude Sonnet); long-context only for the big-window
-- models; local text models are not tagged multilingual unless the family is
-- known for it.
UPDATE curated_models SET use_cases = ARRAY['summarization','chat']
    WHERE model = 'ollama:qwen2.5:3b';
UPDATE curated_models SET use_cases = ARRAY['chat','agentic-tools','summarization']
    WHERE model = 'ollama:qwen3:4b';
UPDATE curated_models SET use_cases = ARRAY['chat','agentic-tools','coding']
    WHERE model = 'ollama:qwen2.5:7b';
UPDATE curated_models SET use_cases = ARRAY['chat','agentic-tools','reasoning','coding']
    WHERE model = 'ollama:qwen3:8b';
UPDATE curated_models SET use_cases = ARRAY['chat','agentic-tools','multilingual']
    WHERE model = 'ollama:llama3.1:8b';
UPDATE curated_models SET use_cases = ARRAY['long-context','chat','multilingual']
    WHERE model = 'ollama:mistral-nemo:12b';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','coding','reasoning','chat']
    WHERE model = 'ollama:qwen2.5:14b';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','reasoning','coding','chat']
    WHERE model = 'ollama:qwen3:30b-a3b';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','coding','reasoning']
    WHERE model = 'ollama:qwen2.5:32b';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','reasoning','coding','writing','multilingual']
    WHERE model = 'ollama:llama3.3:70b';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','coding','long-context','reasoning','chat']
    WHERE model = 'openrouter:z-ai/glm-5.2';
UPDATE curated_models SET use_cases = ARRAY['chat','agentic-tools','coding','writing']
    WHERE model = 'openrouter:anthropic/claude-haiku-4.5';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','reasoning','coding','writing','long-context','vision']
    WHERE model = 'openrouter:anthropic/claude-sonnet-4.6';

-- Later system seeds (migrations 022/023): the current-generation Qwen3 and
-- Gemma 4 rows. Vision only on gemma4:12b (its note says text+image); the big
-- context windows earn long-context.
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','coding','reasoning','chat']
    WHERE model = 'ollama:qwen3:14b';
UPDATE curated_models SET use_cases = ARRAY['agentic-tools','coding','reasoning']
    WHERE model = 'ollama:qwen3:32b';
UPDATE curated_models SET use_cases = ARRAY['chat','summarization']
    WHERE model = 'ollama:gemma4:e2b';
UPDATE curated_models SET use_cases = ARRAY['chat','vision','long-context','multilingual']
    WHERE model = 'ollama:gemma4:12b';
UPDATE curated_models SET use_cases = ARRAY['chat','writing','multilingual']
    WHERE model = 'ollama:gemma4:26b';
UPDATE curated_models SET use_cases = ARRAY['coding','reasoning','chat','writing']
    WHERE model = 'ollama:gemma4:31b';

-- Operator-added rows (is_system=false) are intentionally left untagged — they
-- are the operator's data; tag them in Settings → Models → Curated table.
