-- S10-2: routing by role. `routes.chain` is the ordered list of
-- `provider:model` ids walked when a call names a role; for `chat` the
-- owner's explicit pick (chat.model, sent by core as the request's model)
-- is link 1 and the chain holds only the fallbacks. Roles are code
-- (app/routing.py ROLES), not a CHECK: adding one is a code change + an
-- INSERT. `provider_walls` is "a wall, not a budget": a provider that
-- refused (401/402/403/429/5xx before the stream) is skipped until
-- walled_until, escalating 1h -> 6h -> 24h; a clean completion clears it.
CREATE TABLE IF NOT EXISTS routes (
  role text PRIMARY KEY,
  chain jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_walls (
  provider text PRIMARY KEY REFERENCES providers (name) ON DELETE CASCADE,
  walled_until timestamptz NOT NULL,
  reason text NOT NULL,
  status int NOT NULL,
  strikes int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
