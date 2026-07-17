-- Migration 023: frontier catalog refresh (2026-07-16).
--
-- Policy (Jeremy): Nova recommends CURRENT-GEN models, never vintage. Two
-- mechanisms: (1) this refresh retires superseded 2024-era rows and seeds
-- their successors; (2) the model-manager agent gains web_search and standing
-- instructions to check for newer frontier releases when recommending, so the
-- catalog stops being a decaying snapshot. Requirements remain planning
-- numbers — the probe ("test this model") is the truth on YOUR hardware.

-- retire superseded rows (disabled, not deleted: assignments/history survive,
-- and they vanish from dropdowns + recommendations). qwen2.5:3b stays enabled:
-- it is live-validated and currently on compaction/guard duty.
UPDATE curated_models SET enabled = false, updated_at = now()
WHERE model IN ('ollama:qwen2.5:7b',      -- → qwen3:8b (already seeded)
                'ollama:qwen2.5:14b',     -- → qwen3:14b
                'ollama:qwen2.5:32b',     -- → qwen3:32b
                'ollama:llama3.1:8b',     -- → qwen3:8b / gemma4:12b
                'ollama:mistral-nemo:12b',-- → gemma4:12b (128K → 256K ctx)
                'ollama:llama3.3:70b')    -- → qwen3:32b / gemma4:31b
  AND is_system;

-- current-gen successors (tags verified on ollama.com 2026-07-16)
INSERT INTO curated_models
    (model, provider, min_ram_gb, min_vram_gb, tool_tier, speed, roles, notes, is_system)
VALUES
  ('ollama:qwen3:14b', 'ollama', 16, 12, 'A', 'medium',
   ARRAY['tools','chat'],
   'The tier-A local rung, current generation — dependable multi-round tool use; successor to qwen2.5:14b.', true),
  ('ollama:qwen3:32b', 'ollama', 32, 24, 'A', 'slow',
   ARRAY['tools','chat'],
   'Strong local flagship for 24 GB GPUs; successor to qwen2.5:32b and the llama3.3:70b slot.', true),
  ('ollama:gemma4:26b', 'ollama', 28, 20, 'B', 'slow',
   ARRAY['chat'],
   'Gemma 4 MoE 26B (~4B active): frontier chat quality; MoE routing overhead makes it sluggish interactive — probe before adopting.', true),
  ('ollama:gemma4:31b', 'ollama', 36, 22, 'B', 'slow',
   ARRAY['chat','tools'],
   'Gemma 4 dense flagship: top open-weights math/code benchmarks; tool-call reliability unprobed — the probe is the truth.', true)
ON CONFLICT (model) DO NOTHING;

-- model-manager can now check the world for newer releases
UPDATE agents
SET allowed_tools = array_append(allowed_tools, 'web_search'),
    updated_at = now()
WHERE name = 'model-manager'
  AND NOT ('web_search' = ANY(allowed_tools));

UPDATE agents
SET system_prompt = system_prompt || '

- Nova recommends FRONTIER models, never stale ones. The curated table is a snapshot that ages: when the operator asks for recommendations or the latest models — or the catalog''s newest entries are more than a couple of months old — use web_search to check what''s newer (the Ollama library, major open-weight releases: Qwen, Gemma, Llama, Mistral, DeepSeek families). If something current-gen is missing from the catalog, say so and propose the row (model tag, rough RAM/VRAM needs, roles); the operator adds it in Settings -> Models (edit mode) and verifies with the probe. Never present a superseded generation as the recommendation when its successor is available.',
    updated_at = now()
WHERE name = 'model-manager'
  AND system_prompt NOT LIKE '%recommends FRONTIER models%';
