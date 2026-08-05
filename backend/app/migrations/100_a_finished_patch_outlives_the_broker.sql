-- Migration 100: a finished patch outlives the broker that made it.
--
-- Found the first time phase 4 was pointed at a real session. The coder broker
-- keeps its sessions in a PROCESS-LOCAL DICT, so `docker compose build coder`
-- — or any restart — empties it. Three sessions that had genuinely finished,
-- with commits and diffstats recorded in this table, could not produce their
-- patch:
--
--     "the broker no longer has that session (it restarts with an empty map)"
--
-- The work was not lost — the branch is still in the private clone — but
-- landing it depended on a sidecar's memory, which is not a durable place to
-- keep the one artefact the whole lane exists to move. A change she wrote on
-- Tuesday must still be landable on Thursday.
--
-- So the patch is CAPTURED AT COMPLETION and stored here, and `coder.patch()`
-- reads this column first. The broker stays the source of truth while a
-- session is live and stops being load-bearing the moment it finishes.
--
-- TEXT, not a file: a reviewable diff is kilobytes (the three real ones here
-- are a single README line each), it belongs with the row that describes it,
-- and a file would need its own lifecycle, backup coverage and cleanup story
-- for no benefit. Oversized patches are refused at capture time rather than
-- truncated — half a patch is not a patch, and `git am` on one would fail
-- confusingly instead of clearly.

ALTER TABLE coding_sessions
    ADD COLUMN IF NOT EXISTS patch text,
    ADD COLUMN IF NOT EXISTS patch_captured_at timestamptz;

COMMENT ON COLUMN coding_sessions.patch IS
    'git format-patch output, captured when the session reached a terminal '
    'state. Survives a broker restart; NULL means it was never captured or '
    'the session produced no commit.';
