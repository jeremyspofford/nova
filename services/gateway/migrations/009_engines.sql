-- S40: engines, and what hardware produced a number (docs/plans/rebuild/hub-topology.md;
-- hub/r2-integration.md D8, D10, D21).
--
-- Owner decision 1 (2026-09-18): every model id names the MACHINE it runs on —
-- `hub:qwen3:8b` now, `dell:qwen3.8:27b` once the agent links the Dell (S44).
-- `ollama:x` names a program, not a machine, so the bundled engine's row is renamed
-- `hub` (D8: `hub` is always the bundled container, reached at OLLAMA_URL, and it
-- stays the embedder).
--
-- One rule decides every table that holds a provider name (001-008, checked at
-- 6abf58fa): SETTINGS follow the owner's intent; MEASUREMENTS keep the name that was
-- true when they were written.
--
--   renamed  providers.name 'ollama' -> 'hub'; routes.chain links 'ollama:X' -> 'hub:X'
--            (a link that becomes a duplicate is kept once, where it came first);
--            spend_caps / provider_prices rows, the owner's own settings for that row.
--            Both are inert for a local provider (usage_local_has_no_usd), but left
--            under 'ollama' they would apply to any FUTURE provider named 'ollama'.
--            Rows already keyed 'hub' can only be leftovers of a deleted provider (a
--            live one is refused below), so they go first rather than attach to the
--            bundled engine.
--   deleted  provider_walls for 'ollama': a wall is a transient refusal, not history,
--            and 006's FK has no ON UPDATE, so it would block the rename.
--   kept     usage_events.provider / served_by = 'ollama': that row DID serve those
--            calls under that name. probes keep kind='ollama', and the new `provider`
--            column records 'ollama' for them — the row that served, a fact — while
--            `compute` stays NULL: no code can know which card an old row ran on, so
--            fit never reads it (the 008 precedent).
--
-- Because that history keeps the name, 'ollama' becomes RESERVED (ruling G3): a
-- provider created under it later would take over every pre-S40 usage row and probe,
-- and a measurement would change meaning.
--
-- Core's chat.model / chat.vision_model are rewritten by core's own 035_hub_engine.
-- Idempotent (007's rule): the rename block runs only while a builtin named 'ollama'
-- exists; everything else is IF NOT EXISTS or DROP-then-ADD.

-- What produced a number (D10, app/compute_id.py). NULL = not known: a legacy row, or
-- a stamp the rule omitted. Never guessed, never backfilled.
ALTER TABLE probes ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS compute text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS runtime text;
ALTER TABLE probes ADD COLUMN IF NOT EXISTS path text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS served_on text;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM providers WHERE name = 'hub' AND NOT builtin) THEN
        RAISE EXCEPTION 'migration 009: a provider named "hub" already exists, and "hub" is now the name of the bundled engine. Its hub:<model> chain links would silently start meaning the bundled engine, so nothing was changed. Rename or delete that provider, then start the gateway again.';
    END IF;
    IF EXISTS (SELECT 1 FROM providers WHERE name = 'library') THEN
        RAISE EXCEPTION 'migration 009: a provider named "library" already exists, and library:<slug> now names a model in the library, not a provider. Nothing was changed. Rename or delete that provider, then start the gateway again.';
    END IF;
    IF EXISTS (SELECT 1 FROM providers WHERE name = 'ollama' AND NOT builtin) THEN
        RAISE EXCEPTION 'migration 009: a provider named "ollama" already exists that is not the bundled engine, and "ollama" is the name every usage row and probe from before this migration carries. It would take that history over, so nothing was changed. Rename or delete that provider, then start the gateway again.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM providers WHERE name = 'ollama' AND builtin) THEN
        RETURN;
    END IF;

    DELETE FROM provider_walls WHERE provider = 'ollama';
    DELETE FROM spend_caps WHERE provider = 'hub';
    DELETE FROM provider_prices WHERE provider = 'hub';
    UPDATE spend_caps SET provider = 'hub' WHERE provider = 'ollama';
    UPDATE provider_prices SET provider = 'hub' WHERE provider = 'ollama';
    UPDATE probes SET provider = 'ollama' WHERE provider IS NULL AND kind = 'ollama';
    UPDATE providers SET name = 'hub', updated_at = now() WHERE name = 'ollama' AND builtin;

    UPDATE routes AS r
    SET chain = rewritten.chain, updated_at = now()
    FROM (
        SELECT firsts.role, jsonb_agg(firsts.link ORDER BY firsts.first_at) AS chain
        FROM (
            SELECT links.role, links.link, min(links.ord) AS first_at
            FROM (
                SELECT routes.role,
                       CASE
                           WHEN jsonb_typeof(t.item) = 'string'
                                AND starts_with(t.item #>> '{}', 'ollama:')
                           THEN to_jsonb('hub:' || substr(t.item #>> '{}', 8))
                           ELSE t.item
                       END AS link,
                       t.ord
                FROM routes
                CROSS JOIN LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(routes.chain) = 'array'
                         THEN routes.chain ELSE '[]'::jsonb END
                ) WITH ORDINALITY AS t(item, ord)
            ) AS links
            GROUP BY links.role, links.link
        ) AS firsts
        GROUP BY firsts.role
    ) AS rewritten
    WHERE r.role = rewritten.role AND r.chain IS DISTINCT FROM rewritten.chain;
END $$;

-- One row per ENGINE: a providers row whose adapter is 'ollama'. The owner's settings
-- (lifecycle, serving, hold_s) and the last READY reading, kept for the moments nobody
-- can ask (a machine asleep, S46). A cached value without the time it was read is a
-- CHECK violation, not a row. There is no `compute` column: compute is derived per
-- process from a live reading (app/engines.py) — a database restored onto another
-- machine would otherwise carry a GPU it does not have.
CREATE TABLE IF NOT EXISTS engines (
    provider      text PRIMARY KEY REFERENCES providers (name) ON UPDATE CASCADE ON DELETE CASCADE,
    lifecycle     text NOT NULL DEFAULT 'always_on',
    serving       boolean NOT NULL DEFAULT true,
    hold_s        integer NOT NULL DEFAULT 600,
    last_ready_at timestamptz,
    last_tags     jsonb,
    last_tags_at  timestamptz,
    last_facts    jsonb,
    last_facts_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT engines_lifecycle_is_known CHECK (lifecycle IN ('always_on', 'wake_on_lan')),
    CONSTRAINT engines_hold_s_bounded CHECK (hold_s BETWEEN 60 AND 1800),
    CONSTRAINT engines_tags_dated CHECK ((last_tags IS NULL) = (last_tags_at IS NULL)),
    CONSTRAINT engines_facts_dated CHECK ((last_facts IS NULL) = (last_facts_at IS NULL))
);
INSERT INTO engines (provider)
SELECT name FROM providers WHERE adapter = 'ollama'
ON CONFLICT (provider) DO NOTHING;

-- What /api/show said about each model on each engine (capabilities, context length),
-- keyed by digest. `capabilities` NULL = /api/show stated none — not "none".
CREATE TABLE IF NOT EXISTS engine_models (
    provider       text NOT NULL REFERENCES engines (provider) ON UPDATE CASCADE ON DELETE CASCADE,
    name           text NOT NULL,
    digest         text,
    capabilities   jsonb,
    context_length integer CHECK (context_length > 0),
    read_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, name)
);

-- `hub` IS the builtin and the builtin IS `hub` (found by the flag, named by D8);
-- `library:` names catalogue rows; `ollama` is the name pre-S40 history carries
-- (G3); a non-builtin engine is reached with a token.
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_name_not_reserved;
ALTER TABLE providers ADD CONSTRAINT providers_name_not_reserved
    CHECK (name NOT IN ('library', 'ollama'));
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_hub_is_the_builtin;
ALTER TABLE providers ADD CONSTRAINT providers_hub_is_the_builtin CHECK (builtin = (name = 'hub'));
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_engine_link_has_token;
ALTER TABLE providers ADD CONSTRAINT providers_engine_link_has_token CHECK (
    builtin OR adapter <> 'ollama'
    OR (auth_shape = 'static-bearer' AND coalesce(api_key, '') <> '')
);

ALTER TABLE probes DROP CONSTRAINT IF EXISTS probes_runtime_is_known;
ALTER TABLE probes ADD CONSTRAINT probes_runtime_is_known
    CHECK (runtime IN ('container', 'native', 'wsl'));
ALTER TABLE probes DROP CONSTRAINT IF EXISTS probes_path_is_known;
ALTER TABLE probes ADD CONSTRAINT probes_path_is_known
    CHECK (path IN ('internal', 'host', 'tailnet', 'headscale', 'lan'));
ALTER TABLE probes DROP CONSTRAINT IF EXISTS probes_compute_not_empty;
ALTER TABLE probes ADD CONSTRAINT probes_compute_not_empty CHECK (compute <> '');
-- Fit by (compute, model): a reading on one machine is never read for another.
CREATE INDEX IF NOT EXISTS probes_compute_model
    ON probes (compute, model, created_at DESC) WHERE ok AND frame = 'model';

ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_served_on_not_empty;
ALTER TABLE usage_events ADD CONSTRAINT usage_served_on_not_empty CHECK (served_on <> '');
