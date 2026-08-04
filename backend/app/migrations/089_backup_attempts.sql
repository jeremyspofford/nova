-- When a backup was last TRIED, and what came of it.
--
-- The scheduler's "every N hours" lived in a module global
-- (`scheduler._last_backup`), so it measured uptime rather than time. Every
-- backend restart reset it to 0, the next tick attempted a backup, and a
-- standing refusal notified again. Measured over 24h on 2026-08-04: 76
-- backend starts, 29 refusal notifications, all naming the same file. Under
-- `--reload` every source edit is a restart, so in development the interval
-- was effectively "once a minute, forever".
--
-- Success alone could be derived from the bundle store — the newest bundle's
-- timestamp survives a restart. An ATTEMPT cannot: a refusal writes no
-- bundle, so nothing on disk records that we asked and were told no. That is
-- precisely the case that needs remembering, because it is the one that
-- repeats.
--
-- `reason` is kept so a repeat can be recognised as a repeat. The first
-- refusal is news; the twenty-ninth identical one is noise, and noise is how
-- an operator learns to swipe the alert away without reading it.
CREATE TABLE IF NOT EXISTS backup_attempts (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at      timestamptz NOT NULL DEFAULT now(),
  outcome text        NOT NULL,   -- 'ok' | 'refused' | 'error'
  reason  text,                   -- the refusal or error text, for dedupe
  bundle  text                    -- the bundle path, when outcome = 'ok'
);

CREATE INDEX IF NOT EXISTS backup_attempts_at_idx
  ON backup_attempts (at DESC);

COMMENT ON TABLE backup_attempts IS
  'One row per scheduled backup attempt. Read for two things: whether one is '
  'due (max(at) vs backups.every_hours, which survives a restart where a '
  'module global did not) and whether a refusal is the same refusal as last '
  'time (so an unchanged reason is not re-notified).';
