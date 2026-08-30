-- Earned autonomy (ruling S3-R5): a class at disposition=consent that racks up
-- N consecutive approved-AND-SUCCEEDED runs is PROMOTED to auto — the kernel
-- (policy.authorize) reads disposition already, so a promotion is nothing
-- more than a row edit here, read on the very next call. No parallel
-- decision path: app/autonomy.py is the only writer of these two columns,
-- and it only ever flips disposition alongside them, in one transaction with
-- the governance event that records it (app/governance.py's
-- autonomy.promoted/demoted/revoked).
--
-- consecutive_successes counts a run's worth of burned-and-succeeded calls
-- since the last reset (a failure, a promotion, a demotion or a revoke all
-- reset it to 0 — see autonomy.record_outcome/revoke).
--
-- earned distinguishes a class auto BY GRADUATION from one seeded auto by
-- ruling S3-R1 (workspace_write_file, memory_save, the reads): only an
-- earned class demotes itself on failure or can be revoked in Settings ->
-- Autonomy. A seeded-auto class failing once must not suddenly start
-- gating — that would regress the free file-writing S2 shipped.
ALTER TABLE action_classes
    ADD COLUMN consecutive_successes integer NOT NULL DEFAULT 0,
    ADD COLUMN earned boolean NOT NULL DEFAULT false;
