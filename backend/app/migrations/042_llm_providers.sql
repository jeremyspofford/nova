-- Migration 041: LLM provider registry — bring-your-own provider / any key.
--
-- Until now Nova hardcoded exactly two model providers: bundled Ollama (local)
-- and OpenRouter (cloud). Everything downstream assumed that pair — the model
-- router's prefix switch, the catalog's source list, and this very table's
-- provider CHECK. This registry makes the provider set data: an operator can
-- add OpenAI, Anthropic, Gemini, HuggingFace, Groq, a local LM Studio / vLLM
-- server, or any other OpenAI-compatible endpoint from the UI, each with its
-- own key. The model-id prefix (`slug:model`) selects the provider.
--
-- Anthropic and Gemini are reachable through their OpenAI-compatibility
-- endpoints, so `kind` is 'openai_compat' for everyone in v1 — one client,
-- many configured endpoints. `kind` exists so native adapters can be added
-- later without a schema change.

CREATE TABLE IF NOT EXISTS llm_providers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT NOT NULL UNIQUE,          -- model-id prefix, e.g. 'openai'
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'openai_compat',
    base_url      TEXT NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',      -- never returned over the API
    extra_headers JSONB NOT NULL DEFAULT '{}',
    catalog_path  TEXT NOT NULL DEFAULT '/models', -- '' = provider can't list; approve by id
    needs_key     BOOLEAN NOT NULL DEFAULT true,  -- false for local servers (LM Studio/vLLM)
    enabled       BOOLEAN NOT NULL DEFAULT true,
    is_system     BOOLEAN NOT NULL DEFAULT false, -- seeded rows: editable, not deletable
    -- persistent reachability: stamped on save and by the 60s health loop so
    -- the Providers panel shows a live green/red dot with the WHY (last_error)
    last_checked_at TIMESTAMPTZ,        -- when reachability was last probed
    last_seen_at    TIMESTAMPTZ,        -- last successful reach
    last_ok         BOOLEAN,            -- result of the last check (null = never)
    last_error      TEXT,               -- why the last check failed (surfaced in UI)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT llm_providers_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
    CONSTRAINT llm_providers_slug_not_ollama CHECK (slug <> 'ollama')
);

-- OpenRouter: the batteries-included cloud aggregator, seeded as a system row.
-- Its api_key stays blank here and resolves from the OPENROUTER_API_KEY env at
-- runtime (providers.resolve_key), so existing .env installs keep working with
-- no migration of the secret; an operator can also paste a key in the UI.
INSERT INTO llm_providers (slug, label, base_url, extra_headers, is_system)
VALUES ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1',
        '{"HTTP-Referer": "http://localhost:5173", "X-Title": "Nova"}'::jsonb, true)
ON CONFLICT (slug) DO NOTHING;

-- Provider validity now lives in the app (validated against this registry),
-- not a two-value CHECK on curated_models. Drop the old constraint so a model
-- from any registered provider can be approved. 'ollama' stays valid as the
-- built-in local provider (no row needed).
ALTER TABLE curated_models DROP CONSTRAINT IF EXISTS curated_models_provider_check;
