-- Migration 121: a dead coding session says so.
--
-- MEASURED 2026-08-07. Session 6d085e4f-d25c-49d0-99f0-69115622d426 was
-- started at 18:34:08, recorded exactly one command (`ls /workspaces/`) and a
-- permission error, and then stopped. At 18:58 — twenty-four minutes later —
-- its row still read `state = 'running'`. Nothing flagged it, nothing timed
-- it out, and the operator asking "did that work?" would have been told it
-- was still going. A session that has died and a session that is thinking
-- look identical, and that is the defect.
--
-- WHY `updated_at` COULD NOT ANSWER THIS. `_update` stamps `updated_at` on
-- every write, and `refresh` writes on every poll — so the column measures
-- ATTENTION, not progress. A session nobody polls looks dead while healthy;
-- a wedged session polled in a loop looks alive forever. Both directions are
-- wrong, which is why this adds a second clock instead of reading that one.
--
-- `progress_fingerprint` is derived from what the broker reports actually
-- CHANGING: state, commit, diffstat, and the counts of commands and denials.
-- `progress_at` moves only when that fingerprint moves. A session whose
-- fingerprint has been still for longer than the stall window is stalled —
-- and, crucially, that is decided after a LIVE poll of the broker, never
-- from the row alone. Judging staleness from a row nobody refreshed would
-- turn "we stopped looking" into "it died", which is the same class of
-- untrue-but-reassuring answer this migration exists to remove.
--
-- The reconciler is a MECHANICAL automation (handler column, migration 112):
-- no agent sees it, because "is this session dead" is a question with a
-- mechanical answer and a model asked to judge it would narrate one.

ALTER TABLE coding_sessions
    ADD COLUMN IF NOT EXISTS progress_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ;

COMMENT ON COLUMN coding_sessions.progress_fingerprint IS
    'Digest of the broker-reported signals that indicate real work: state, '
    'commit, diffstat, and command/denial counts. Compared to detect a '
    'session that is running but no longer progressing.';

COMMENT ON COLUMN coding_sessions.progress_at IS
    'When progress_fingerprint last CHANGED — not when the row was last '
    'written. updated_at measures polling; this measures progress.';

-- Existing non-terminal rows get a starting clock so the reconciler judges
-- them from now rather than declaring every historical row stalled on its
-- first tick.
UPDATE coding_sessions
   SET progress_at = COALESCE(progress_at, updated_at, created_at)
 WHERE state NOT IN ('done', 'failed', 'killed', 'stalled')
    OR progress_at IS NULL;

INSERT INTO automations (name, description, instruction, agent_name,
                         interval_minutes, schedule, timeout_seconds,
                         enabled, is_system, next_run_at, notify, handler)
VALUES (
    'coding-session-reconcile',
    'Polls every coding session that is still running and marks the ones '
    'that have stopped making progress as stalled, with their last evidence '
    'attached. A session that died stops claiming to be working.',
    'MECHANICAL — the scheduler runs coder.reconcile_stalled() in code. No '
    'agent receives this text. Each non-terminal session is refreshed '
    'against the broker first, so "stalled" always follows a live check and '
    'never merely an unobserved row.',
    'main',
    5,
    NULL,
    300,
    true, true,
    now() + interval '2 minutes',
    false,
    'coder_reconcile')
ON CONFLICT (name) DO NOTHING;
