-- Migration 112: a backup is proven weekly, and credentials come along.
--
-- ROADMAP #31, the NEXT section. Jeremy restated the goal 2026-08-02 and it
-- reversed a default: "if a computer crashes, spin Nova up on a different
-- machine and keep configurations, secrets, conversation and memories."
-- That is DISASTER RECOVERY, and a bundle that cannot bring up a working
-- system does not satisfy it. So bundles are now COMPLETE (.env, the
-- secrets master key, tailscale state) and ENCRYPTED (AES-GCM, scrypt) —
-- encryption is what makes a complete bundle safe to copy off-machine.
--
-- Two things land here:
--
-- 1. `automations.handler` — a MECHANICAL automation. A row whose handler
--    names an entry in scheduler.MECHANICAL_HANDLERS is run as code; no
--    agent ever sees it. The scheduled snapshot solved this problem by not
--    being an automation at all (scheduler._maybe_backup, migration 089),
--    at the price of being invisible and unschedulable. This keeps the
--    mechanical property AND the real schedule row: visible in the UI,
--    movable to another night, notify:true delivered by the backend
--    (migration 108), run history, auto-disable — all unchanged.
--    The column is deliberately NOT in automations.UPDATABLE: only a
--    migration writes it, because a writable handler would let a model
--    point the scheduler at arbitrary registered code, and a clearable one
--    would silently hand a mechanical job's row to an agent as a prompt.
--
-- 2. The weekly restore drill (decision c, asked and answered 2026-08-02):
--    restore the NEWEST bundle into a scratch database, verify it — the
--    full chain now: passphrase source answers, payload decrypts and
--    authenticates, archive verifies, dump restores, migration gate passes
--    — then drop the scratch and report. A backup that has never been
--    restored is a hope; this makes it a weekly fact. notify:true because a
--    failed drill has to reach the operator directly, not only the journal.
--    Sunday 03:00 in his timezone (a real schedule, migration 107), clear
--    of the nightly tournament window and the morning reminders.
--
--    The first run is seeded ~10 minutes out — same reasoning as migration
--    109: the first run of anything unattended should happen while someone
--    can still be watching. The schedule governs every run after.
--
--    `agent_name` is 'main' only because the column is NOT NULL and predates
--    mechanical rows; run_one never reads it when handler is set.
--
-- Also: any stored override of backups.include_secrets is cleared. The row
-- could only say `false` — the old default, from the era when a complete
-- bundle meant a PLAINTEXT complete bundle (ced70b8). That era's reasoning
-- does not survive encryption, and the decision above supersedes it; the
-- new code default (true) governs. An operator who wants a credential-free
-- bundle can still turn it off, now meaning what it says.

ALTER TABLE automations ADD COLUMN IF NOT EXISTS handler TEXT;

COMMENT ON COLUMN automations.handler IS
    'Mechanical automation: names an entry in scheduler.MECHANICAL_HANDLERS '
    'and the scheduler runs CODE — the agent path is never consulted and '
    'the instruction text is documentation. Written only by migrations; '
    'deliberately absent from automations.UPDATABLE.';

INSERT INTO automations (name, description, instruction, agent_name,
                         interval_minutes, schedule, timeout_seconds,
                         enabled, is_system, next_run_at, notify, handler)
VALUES (
    'weekly-restore-drill',
    'Restores the newest backup into a scratch database every week and '
    'proves the whole chain: passphrase, decryption, archive, database, '
    'migrations. Fails loudly; never touches live data.',
    'MECHANICAL — the scheduler runs backup_service.drill() in code. No '
    'agent receives this text; it exists so a human reading this row knows '
    'what runs and where. The drill restores the newest bundle into a '
    'throwaway database named nova_verify_<8hex>, verifies it against the '
    'live schema and the migration ledger, drops it, and reports.',
    'main',
    10080,
    '{"every": "week", "on": ["sun"], "at": "03:00"}'::jsonb,
    1800,
    true, true,
    now() + interval '10 minutes',
    true,
    'restore_drill')
ON CONFLICT (name) DO NOTHING;

DELETE FROM settings WHERE key = 'backups.include_secrets';
