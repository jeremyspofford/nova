-- When the gateway last probed a wall (epic wall-probe, T4): a provider
-- walled for credits (stored status 402) is re-checked by the gateway itself
-- once an hour with one 1-token completion (wall_probe), and this is the
-- time of that last probe. Kept apart from `updated_at`, the time of the
-- wall's latest REFUSAL, so a probe that failed without a refusal never
-- fakes a refusal time. Nullable, no default: a wall nobody has probed says
-- so, and the hour counts from greatest(updated_at, probed_at).
ALTER TABLE provider_walls
    ADD COLUMN IF NOT EXISTS probed_at timestamptz;
