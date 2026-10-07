-- Nova updating herself (docs/plans/rebuild/about-and-updates.md, part 2).
--
-- Each ATTEMPT to move the hub to a newer commit, and what decided it. A row
-- is opened `sent` before the command leaves for the hub's own agent, so the
-- next core — the one the update creates — has something to decide. Only two
-- things decide it, and neither is a sentence of hers:
--   * the installer's own report (python -m app.updates_cli finish), and
--   * for `confirmed`, the reporting core's own NOVA_COMMIT being the target.
-- A row nobody decides within app.nova_updates.CONFIRM_WITHIN reads as
-- not_confirmed and stops holding the one open slot.
CREATE TABLE nova_updates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_commit  text NOT NULL CHECK (from_commit ~ '^[0-9a-f]{40}$'),
    -- NULL only for a refusal the installer made before it knew the target.
    to_commit    text CHECK (to_commit ~ '^[0-9a-f]{40}$'),
    -- 'nova', a person's name, or 'by hand on the hub' (an ./install update
    -- nobody started from core).
    requested_by text NOT NULL,
    -- The hub agent the command went to, and where its log is on that host.
    device       text,
    log_path     text,
    outcome      text NOT NULL CHECK (
        outcome IN ('sent', 'confirmed', 'failed', 'refused', 'up_to_date', 'not_confirmed')
    ),
    reason       text,
    started_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz
);

-- One update in flight, for everyone: the database's own answer, not a check
-- that two requests can both pass.
CREATE UNIQUE INDEX nova_updates_one_open ON nova_updates ((true)) WHERE outcome = 'sent';
CREATE INDEX nova_updates_recent ON nova_updates (started_at DESC);
