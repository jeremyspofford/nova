-- A wall is about what refused, and a model is not a provider.
--
-- 2026-09-10, live: `qwen3.8:27b` did not answer within the read budget. The
-- wall was keyed by PROVIDER, so `qwen3:8b` — the next link in the same chain,
-- which had done nothing wrong and was never called — was walled with it. The
-- owner's retry twelve seconds later failed instantly with a wall of text
-- naming two walled models, and every question for the next hour would have
-- done the same. On a box whose only provider is the local ollama, a
-- provider-wide wall is a wall across everything.
--
-- The status already says which kind of failure it was, so nothing here needs
-- a list anyone maintains:
--
--   401/402/403/429  the provider talking about your ACCOUNT — another model
--                    on the same key refuses identically, so the wall is
--                    provider-wide and `model` is ''.
--   5xx              one model failing to serve right now. `model` names it,
--                    and its siblings stay runnable.
--
-- '' rather than NULL because it is half of the primary key, and a NULL there
-- would make "the provider-wide wall" a row you cannot address.

-- Idempotent, like every migration beside it (006 is all IF NOT EXISTS): the
-- provider tests build a legacy schema and run the whole set over it, so a
-- statement that can only run once turns four of them red.
ALTER TABLE provider_walls DROP CONSTRAINT IF EXISTS provider_walls_pkey;

ALTER TABLE provider_walls
    ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';

ALTER TABLE provider_walls
    ADD CONSTRAINT provider_walls_pkey PRIMARY KEY (provider, model);
