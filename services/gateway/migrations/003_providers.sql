-- S10-pre: the provider registry. Vendors are not the unit, PROTOCOLS are:
-- a provider is a row naming an adapter (wire protocol), a base URL, an
-- auth shape and a key. Model identity everywhere is `provider:model`.
--
-- The single-row backend_config of S1 is CONVERTED into rows here and then
-- dropped: its `remote` kind becomes a provider named `remote`, its `cloud`
-- kind a provider named after its `provider` column (or `cloud`), and the
-- bundled ollama is a builtin row that every install has. Whichever kind
-- was active becomes the DEFAULT provider — the one a bare model id (no
-- provider prefix, e.g. `qwen3.8:27b`) routes to — so nothing an owner had
-- chosen changes meaning across this migration.
CREATE TABLE IF NOT EXISTS providers (
    -- A slug, never containing ':' — the model-id split is on the FIRST
    -- colon, so a name with one would be unroutable.
    name          text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    adapter       text NOT NULL CHECK (adapter IN ('ollama', 'openai-chat', 'anthropic-messages')),
    -- INCLUDES the version path (`https://openrouter.ai/api/v1`), the
    -- OPENAI_BASE_URL convention. Empty for the builtin ollama row, whose
    -- address is resolved live from OLLAMA_URL and never from this column.
    base_url      text NOT NULL,
    auth_shape    text NOT NULL CHECK (auth_shape IN ('none', 'static-bearer', 'api-key-header')),
    api_key       text,
    -- Used when a request names no model at all (the S1 fallback, kept).
    default_model text,
    -- Free text the owner reads when typing a model id ("deployment name",
    -- "vendor.model prefix").
    model_note    text,
    -- Which preset seeded this row, if any. Convenience only: never read
    -- by routing.
    preset        text,
    -- The bundled ollama: cannot be deleted, address from the environment.
    builtin       boolean NOT NULL DEFAULT false,
    is_default    boolean NOT NULL DEFAULT false,
    verified_at   timestamptz,
    -- What the last verify learned about GET /models: 'available' (it
    -- listed), 'unavailable' (404/405 — the owner types model ids),
    -- 'unknown' (never verified through the registry, e.g. a converted row).
    listing       text NOT NULL DEFAULT 'unknown'
                  CHECK (listing IN ('available', 'unavailable', 'unknown')),
    listing_note  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Exactly one default, enforced by the database and not by code that
-- remembers to clear the old one.
CREATE UNIQUE INDEX IF NOT EXISTS providers_one_default
    ON providers ((true)) WHERE is_default;

INSERT INTO providers (name, adapter, base_url, auth_shape, builtin, is_default)
VALUES ('ollama', 'ollama', '', 'none', true, true)
ON CONFLICT (name) DO NOTHING;

DO $$
DECLARE
    legacy record;
    slug text;
BEGIN
    IF to_regclass('backend_config') IS NULL THEN
        RETURN;
    END IF;
    SELECT * INTO legacy FROM backend_config WHERE id = 1;
    IF legacy IS NULL OR legacy.kind = 'ollama' OR legacy.url IS NULL OR legacy.url = '' THEN
        RETURN;
    END IF;
    IF legacy.kind = 'remote' THEN
        slug := 'remote';
    ELSE
        slug := coalesce(
            nullif(regexp_replace(lower(legacy.provider), '[^a-z0-9_-]+', '-', 'g'), ''),
            'cloud'
        );
        slug := regexp_replace(slug, '^[^a-z0-9]+', '');
        IF slug = '' OR slug = 'ollama' THEN
            slug := 'cloud';
        END IF;
    END IF;
    INSERT INTO providers (
        name, adapter, base_url, auth_shape, api_key, default_model, listing
    ) VALUES (
        slug,
        'openai-chat',
        rtrim(legacy.url, '/') || '/v1',
        CASE WHEN legacy.kind = 'cloud' THEN 'static-bearer' ELSE 'none' END,
        legacy.api_key,
        legacy.model,
        'unknown'
    )
    ON CONFLICT (name) DO NOTHING;
    UPDATE providers SET is_default = false WHERE is_default;
    UPDATE providers SET is_default = true WHERE name = slug;
END $$;

DROP TABLE IF EXISTS backend_config;
