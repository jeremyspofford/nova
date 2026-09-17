-- S22: a measurement is only meaningful inside the frame it was taken in.
--
-- Until this slice, POST /admin/probe recorded `vram_mb` as a WHOLE-CARD
-- nvidia-smi reading (ruling S2f-R3): the desktop's own baseline plus the
-- model. S22 moved `needed_gb` to the MODEL'S OWN VRAM — ollama's per-model
-- /api/ps `size_vram` — because the baseline now lives on the free side,
-- where the driver has already subtracted it (see app/fit.py, "THE FRAME").
--
-- Every probe row written before that is a number in a frame that no longer
-- exists, and it reads about 2.6 GB too high in the new one. Left alone, the
-- 27B's old 21.8 GB reading made it `wont_fit` on a card where it
-- demonstrably runs — caught on the live stack minutes after deploying.
--
-- The rows are NOT deleted and the readings are NOT nulled: probes are a
-- ledger, and "we probed this model on this date and it took 21.8 GB
-- whole-card" is true and worth keeping. What changes is which rows a FIT
-- DECISION may read. `frame` says which world a reading belongs to, existing
-- rows are stamped 'whole_card', new ones 'model', and admin._latest_probes
-- selects only 'model'. A model with no reading in the current frame falls
-- back to its download size or the curated estimate until it is re-probed,
-- which is the honest answer: nobody has measured it the way we now measure.

ALTER TABLE probes
    ADD COLUMN IF NOT EXISTS frame text NOT NULL DEFAULT 'whole_card';

-- New rows default to the current frame; the backfill above has already
-- stamped every existing row as what it actually is.
ALTER TABLE probes
    ALTER COLUMN frame SET DEFAULT 'model';

ALTER TABLE probes
    DROP CONSTRAINT IF EXISTS probes_frame_is_known;
ALTER TABLE probes
    ADD CONSTRAINT probes_frame_is_known CHECK (frame IN ('whole_card', 'model'));
