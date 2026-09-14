-- S21: what the model's LOAD cost, kept out of the first case's score.
--
-- A suite run scores its cases alphabetically, so case one is always the same
-- case, and before this it also paid for whatever loading the model needed —
-- 17 GB off disk into VRAM when the previous run used a different model. The
-- cost landed inside a scored turn, invisible, in the one place nobody would
-- look for it; a cold load slow enough to push the first token past the
-- gateway's 300 s silence budget would have made bare-intent-no-action
-- ungradeable for a reason that has nothing to do with the model.
--
-- So the job now sends ONE throwaway generation before the first case and does
-- not score it. These two columns are what that cost, recorded rather than
-- discarded: a load is a real fact about running this model on this machine,
-- and the operator should be able to see "41 s" instead of wondering.
--
-- Both nullable: a run from before this, and a run whose warm-up could not be
-- made at all, carry no number — never a 0, which would read as "loaded
-- instantly".
ALTER TABLE eval_suite_runs ADD COLUMN IF NOT EXISTS warmup_ms int;

-- Why there is no number, in words, when there is none: the warm-up is
-- best-effort (a gateway that cannot be asked must not stop a run whose cases
-- will each state their own failure), and a silent absence would read exactly
-- like a run that never needed one.
ALTER TABLE eval_suite_runs ADD COLUMN IF NOT EXISTS warmup_note text;
