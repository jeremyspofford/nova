-- S10: the spend ledger. One row per completion the gateway served (or
-- refused, or probed), written when the stream ends. The rails it encodes:
--   * unmetered is NULL tokens and metered=false, NEVER zero (a provider
--     that stated no counts is recorded as having stated none);
--   * a local call carries no dollars (usage_local_has_no_usd) — GPU time is
--     duration_ms, a different unit, never priced;
--   * a cost always names its basis (usage_cost_has_basis): the provider's
--     own reported figure, the owner's entered price, the listing's price,
--     or the dated curated list.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS usage_supported boolean;  -- NULL untested
ALTER TABLE providers ADD COLUMN IF NOT EXISTS local boolean NOT NULL DEFAULT false;
UPDATE providers SET local = true WHERE adapter = 'ollama';

CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  model text NOT NULL,
  served_by text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('completion', 'refusal', 'probe')),
  purpose text NOT NULL,
  role text,
  turn_id uuid,
  person_id uuid,
  prompt_tokens int,
  completion_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  duration_ms int NOT NULL,
  local boolean NOT NULL,
  cost_usd numeric(12, 6),
  cost_basis text CHECK (cost_basis IN ('provider-reported', 'owner-price', 'listing-price', 'curated-price')),
  metered boolean GENERATED ALWAYS AS (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL) STORED,
  status int NOT NULL,
  error text,
  route_reason text,
  route_link int,
  CONSTRAINT usage_local_has_no_usd CHECK (NOT local OR cost_usd IS NULL),
  CONSTRAINT usage_cost_has_basis CHECK ((cost_usd IS NULL) = (cost_basis IS NULL))
);
CREATE INDEX IF NOT EXISTS usage_events_at_provider ON usage_events (at DESC, provider);
CREATE INDEX IF NOT EXISTS usage_events_turn ON usage_events (turn_id);
CREATE INDEX IF NOT EXISTS usage_events_person_at ON usage_events (person_id, at DESC);

-- Monthly caps in USD per provider; the '*' row is the total across every
-- cloud provider. NULL = no cap. Local providers are never capped in USD.
CREATE TABLE IF NOT EXISTS spend_caps (
  provider text PRIMARY KEY,
  monthly_usd numeric(12, 2),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO spend_caps (provider, monthly_usd) VALUES ('*', NULL) ON CONFLICT DO NOTHING;

-- Prices per token by (provider, model, basis). `listing` rows are written
-- by every live listing fetch; `curated` rows come from the dated file for
-- providers whose listing states no price (Anthropic); `owner` rows are
-- typed by the owner and win over both.
CREATE TABLE IF NOT EXISTS provider_prices (
  provider text NOT NULL,
  model text NOT NULL,
  basis text NOT NULL CHECK (basis IN ('owner', 'listing', 'curated')),
  prompt_usd_per_token numeric(18, 12) NOT NULL,
  completion_usd_per_token numeric(18, 12) NOT NULL,
  cache_read_multiplier numeric(6, 4),
  cache_write_multiplier numeric(6, 4),
  verified_at timestamptz NOT NULL,
  source text,
  PRIMARY KEY (provider, model, basis)
);
