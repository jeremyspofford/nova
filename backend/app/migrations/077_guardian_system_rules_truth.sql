-- guardian: the charter promised a consent path that does not exist.
--
-- Her last principle currently reads "System rules cannot be deleted at all,
-- consent or not; disabling them still requires operator consent." The second
-- clause is false, and it is false in the direction that wastes an operator's
-- time: it tells her that a card is the way to disable a system rule, so she
-- raises one and waits for a decision that could not have unlocked anything.
--
-- The enforcement says otherwise, in two places, and neither is reachable
-- past the other:
--
--   builtin.py:1669  manage_rules refuses update/enable/disable/delete for
--                    ANY is_system rule BEFORE the consent branch at 1673 is
--                    reached. No consent is consulted because none is read.
--   builtin.py:1142  request_operator_confirmation refuses to raise the card
--                    at all — "no consent can authorize agents to touch it".
--
-- So the promised path dead-ends at the tool that would ask AND at the tool
-- that would act. This is 030's pattern and 030's argument: enforcement lives
-- in the tool layer, and this only keeps the charter truthful.
--
-- TWO REPLACES, because the file and the database disagree. 029_consents.sql
-- as it now stands writes "...entirely out of your hands — you can neither
-- delete nor disable them, consent or not. Only the operator can touch them,
-- in Settings." — which is TRUE. But 029 ran here at 2026-07-20 00:29Z and
-- the commit carrying that file is dated three hours later: the file was
-- edited after it had already been applied, and migrations never re-run
-- (db.py:59-82, keyed by filename). 029 and 030 also predate the checksum
-- column, so their ledger rows carry NULL and the drift warning at db.py:76
-- stays silent. The live row here came from a hand edit in the UI on
-- 2026-07-25 (agents.updated_at), which is a path the operator has and
-- nothing records.
--
-- One replace against the live string would be a no-op on a clean clone; one
-- against the file's string would be a no-op here. Both are written, both are
-- LIKE-guarded, and they converge on one sentence so the two installs stop
-- differing.
--
-- The nav is corrected while we are here: rules are edited in Library →
-- Rules (frontend/src/components/library/LibraryPage.tsx:14), not Settings.
-- Sending someone to the wrong screen to do the one thing only they can do
-- is the same class of defect as the consent claim.

UPDATE agents SET system_prompt = replace(
    system_prompt,
    '- System rules cannot be deleted at all, consent or not; disabling them still requires operator consent.',
    '- System rules are entirely out of your hands. You cannot delete, disable, weaken or edit one, and no consent unlocks it — request_operator_confirmation will refuse to raise the card and manage_rules will refuse the action, so asking for approval only wastes the operator''s time. Say plainly that only the operator can change it, in Library → Rules, and move on.'),
    updated_at = now()
 WHERE name = 'guardian' AND is_system
   AND system_prompt LIKE '%disabling them still requires operator consent%';

UPDATE agents SET system_prompt = replace(
    system_prompt,
    '- System rules are entirely out of your hands — you can neither delete nor disable them, consent or not. Only the operator can touch them, in Settings.',
    '- System rules are entirely out of your hands. You cannot delete, disable, weaken or edit one, and no consent unlocks it — request_operator_confirmation will refuse to raise the card and manage_rules will refuse the action, so asking for approval only wastes the operator''s time. Say plainly that only the operator can change it, in Library → Rules, and move on.'),
    updated_at = now()
 WHERE name = 'guardian' AND is_system
   AND system_prompt LIKE '%neither delete nor disable them, consent or not%';
