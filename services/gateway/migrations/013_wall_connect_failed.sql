-- Why a wall was made, typed (S46a T9): true when the refusal that made it
-- failed in the CONNECT phase — nothing took the request (adapters
-- CONNECT_PHASE_ERRORS on its cause chain). The first such failure on a
-- non-engine link walls that model for up to 30 min, and while it stands the
-- link is never dialled again, so this column is the only thing that can
-- tell core the machine behind it was not answering (core wakes it). It is
-- replaced by every later refusal, as the reason is. Never read off `reason`.
ALTER TABLE provider_walls
    ADD COLUMN IF NOT EXISTS connect_failed boolean NOT NULL DEFAULT false;
