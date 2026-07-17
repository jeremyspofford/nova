-- Migration 022: hardware-tiered voice-model recommendations (2026-07-16).
--
-- The voice-reply model (voice.model_override) is latency-sensitive and — once
-- always-listening lands (voice plan §4d) — should be LOCAL: an always-on mic
-- feeding a cloud model is a privacy and cost problem, not a picker choice.
-- The roles vocabulary gains 'voice' (curated_models._ROLES); these seeds mark
-- which rows suit spoken exchanges at each hardware tier. Current-gen picks
-- only — Nova recommends frontier, not vintage.

-- tiny/no-GPU fallback: already the best tools-per-GB small model
UPDATE curated_models
SET roles = array_append(roles, 'voice'), updated_at = now()
WHERE model = 'ollama:qwen3:4b' AND NOT ('voice' = ANY(roles));

-- ~8 GB GPU tier: the balanced voice default
UPDATE curated_models
SET roles = array_append(roles, 'voice'), updated_at = now()
WHERE model = 'ollama:qwen3:8b' AND NOT ('voice' = ANY(roles));

INSERT INTO curated_models
    (model, provider, min_ram_gb, min_vram_gb, tool_tier, speed, roles, notes, is_system)
VALUES
  -- CPU-first frontier: MoE with ~2B active params — near-frontier replies at
  -- small-model latency, the strongest no-GPU voice pick (needs the RAM for
  -- its full weights even though few activate per token)
  ('ollama:gemma4:e2b', 'ollama', 12, 6, 'B', 'fast',
   ARRAY['voice','chat'],
   'Gemma 4 MoE (~2B active): frontier-quality replies at small-model latency — the no-GPU voice pick for 12 GB+ RAM machines. 128K context.', true),
  -- 10 GB+ GPU tier: frontier dense mid-size
  ('ollama:gemma4:12b', 'ollama', 14, 10, 'B', 'medium',
   ARRAY['voice','chat'],
   'Gemma 4 dense 12B: the voice pick for 10 GB+ GPUs — frontier judgment for spoken exchanges; 256K context, text+image.', true)
ON CONFLICT (model) DO NOTHING;
