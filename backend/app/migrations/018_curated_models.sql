-- Migration 018: curated model table — the knowledge behind model
-- recommendations (designed 2026-07-14). Hand-curated seed; DB-backed so the
-- operator can edit it (edit mode) and an ingestion automation can refresh
-- it later. Requirements are rough planning numbers for the default
-- quantization, not guarantees — the probe ("test this model") is the truth.
--
-- tool_tier: A = dependable multi-round tool use, B = reliable single calls
-- with occasional judgment misses, C = chat-grade only.
-- speed: size-class latency expectation (fast <=4B, medium ~7-14B, slow >14B;
-- cloud rows rated on observed API latency).
-- roles: which agent profiles the model suits (chat|tools|guard|compaction).

CREATE TABLE IF NOT EXISTS curated_models (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model        TEXT NOT NULL UNIQUE,
    provider     TEXT NOT NULL CHECK (provider IN ('ollama', 'openrouter')),
    min_ram_gb   INTEGER,
    min_vram_gb  INTEGER,
    tool_tier    TEXT NOT NULL DEFAULT 'C' CHECK (tool_tier IN ('A', 'B', 'C')),
    speed        TEXT NOT NULL DEFAULT 'medium' CHECK (speed IN ('fast', 'medium', 'slow')),
    roles        TEXT[] NOT NULL DEFAULT '{}',
    notes        TEXT NOT NULL DEFAULT '',
    is_system    BOOLEAN NOT NULL DEFAULT false,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    last_probe   JSONB,
    probed_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO curated_models
    (model, provider, min_ram_gb, min_vram_gb, tool_tier, speed, roles, notes, is_system)
VALUES
  ('ollama:qwen2.5:3b', 'ollama', 4, 3, 'B', 'fast',
   ARRAY['compaction','guard'],
   'Live-validated on Nova''s machinery. Clean function calls for its size, but judgment trails 7B+ — keep it on summarization and simple checks.', true),
  ('ollama:qwen3:4b', 'ollama', 6, 4, 'B', 'fast',
   ARRAY['chat','guard','compaction'],
   'Newer small Qwen; best tools-per-GB in the tiny class.', true),
  ('ollama:qwen2.5:7b', 'ollama', 8, 6, 'B', 'medium',
   ARRAY['chat','tools'],
   'The balanced default for 8 GB+ machines; solid tool calling.', true),
  ('ollama:qwen3:8b', 'ollama', 10, 8, 'B', 'medium',
   ARRAY['chat','tools'],
   'Stronger judgment than qwen2.5:7b at similar cost.', true),
  ('ollama:llama3.1:8b', 'ollama', 10, 8, 'B', 'medium',
   ARRAY['chat','tools'],
   'Solid alternative family; good ecosystem familiarity.', true),
  ('ollama:mistral-nemo:12b', 'ollama', 14, 10, 'B', 'medium',
   ARRAY['chat','tools'],
   '128k context; decent function calling.', true),
  ('ollama:qwen2.5:14b', 'ollama', 16, 12, 'A', 'medium',
   ARRAY['tools','chat'],
   'First tier-A local rung — dependable multi-round tool use.', true),
  ('ollama:qwen3:30b-a3b', 'ollama', 24, 20, 'A', 'medium',
   ARRAY['tools','chat'],
   'MoE with 3B active params: near-14B latency with 30B-class quality. Best CPU pick at 32 GB+ RAM.', true),
  ('ollama:qwen2.5:32b', 'ollama', 32, 24, 'A', 'slow',
   ARRAY['tools'],
   'Strong tool reliability; GPU strongly recommended for interactive use.', true),
  ('ollama:llama3.3:70b', 'ollama', 48, 40, 'A', 'slow',
   ARRAY['tools'],
   'Flagship local; needs serious hardware (48 GB+ RAM or 40 GB+ VRAM).', true),
  ('openrouter:z-ai/glm-5.2', 'openrouter', NULL, NULL, 'A', 'fast',
   ARRAY['chat','tools'],
   'Nova''s cloud default: $0.93/$2.92 per M tokens, 1M context, parallel tool calls verified live 2026-07-14.', true),
  ('openrouter:anthropic/claude-haiku-4.5', 'openrouter', NULL, NULL, 'A', 'fast',
   ARRAY['chat','tools','guard'],
   'Fast premium cloud; strong instruction following for guard duty.', true),
  ('openrouter:anthropic/claude-sonnet-4-6', 'openrouter', NULL, NULL, 'A', 'medium',
   ARRAY['tools','chat'],
   'Premium judgment for the hardest research and multi-step tool work.', true)
ON CONFLICT (model) DO NOTHING;

-- model-manager gains the recommendation tool and learns what it's for
UPDATE agents
SET allowed_tools = array_append(allowed_tools, 'recommend_models'),
    updated_at = now()
WHERE name = 'model-manager'
  AND NOT ('recommend_models' = ANY(allowed_tools));

-- the agent index (description + keywords) is how main decides to dispatch —
-- it must advertise the new capability or "what model should I run" never
-- reaches this agent (found live: main answered "I can't inspect hardware")
UPDATE agents
SET description = 'Manages Nova''s model inventory and fit: lists what''s available across providers, downloads new local models (Ollama), and recommends which model each agent should use based on this machine''s hardware (RAM, cores, GPU). Dispatch "what models do we have", "get/download/pull a model", or "what model should I/my agents use" requests here.',
    routing_keywords = ARRAY['model','pull','download','inference','llm','ollama','recommend','hardware'],
    updated_at = now()
WHERE name = 'model-manager';

-- main learns the expanded category (migration-016 pattern)
UPDATE agents
SET system_prompt = replace(system_prompt,
                            'listing or downloading models',
                            'listing, downloading, or recommending models (hardware-aware)'),
    updated_at = now()
WHERE name = 'main'
  AND system_prompt NOT LIKE '%recommending models%';

UPDATE agents
SET system_prompt = system_prompt || '

- recommend_models reads the machine''s hardware (RAM, cores, GPU) and the curated model table, then suggests a model per agent role with reasons and alternates. Use it whenever the user asks "what model should I run" or wants their agents tuned to their hardware. Present the reasons, not just the names; mention that suggestions can be verified with the test probe in Settings → Inference.',
    updated_at = now()
WHERE name = 'model-manager'
  AND system_prompt NOT LIKE '%recommend_models%';
