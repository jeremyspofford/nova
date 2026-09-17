-- 017: no approvals (owner ruling 2026-09-03). v4 makes no authorization
-- decisions: the kernel, its consents and dispositions, earned autonomy, the
-- per-device grants and the approval choreography in messages are gone.
-- Forward-only: 004-015 are applied on the live DB and are matched by
-- filename, so they stay on disk untouched; on a fresh DB they create what
-- this drops, and IF EXISTS makes both paths land in the same place. Dev
-- stage: no rows are preserved.

DROP TABLE IF EXISTS consents;                       -- 005
DROP TABLE IF EXISTS action_classes;                 -- 004/007/008/009/012

ALTER TABLE devices
  DROP COLUMN IF EXISTS capabilities,                -- 011
  DROP COLUMN IF EXISTS fs_roots,                    -- 011
  DROP COLUMN IF EXISTS home_dir;                    -- 013

-- The graduation threshold has no reader once autonomy.py is gone; an orphan
-- row would be invisible to the registry (settings_store reads defs only).
DELETE FROM settings WHERE key = 'autonomy.graduation_runs';

-- The choreography rows 014/015 hid from the history window ("[waiting for
-- your approval before continuing]", "You're approved: ... go ahead") were
-- never things the household said to each other; with no approval step they
-- have no writer, and the column that marked them goes with them.
DELETE FROM messages WHERE kind = 'plumbing';        -- 014/015
ALTER TABLE messages DROP COLUMN IF EXISTS kind;

-- The ledger stays as a RECORD (device.enrolled / device.revoked /
-- device.audit_break). Rows of the nine kinds only the kernel wrote are
-- decisions of a kernel that no longer exists; a page showing them would
-- mislead the reader. action_class was set by those kinds alone.
DELETE FROM governance_events WHERE kind IN (
  'consent.raised', 'consent.decided', 'consent.burned', 'policy.denied',
  'autonomy.promoted', 'autonomy.demoted', 'autonomy.revoked',
  'autonomy.disposition_set', 'device.grants_changed');
ALTER TABLE governance_events DROP COLUMN IF EXISTS action_class;
