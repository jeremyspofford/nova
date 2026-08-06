-- Migration 102: only a green sandbox may land.
--
-- `docs/plans/sandbox-instance.md` phase 3, and the clause the whole document
-- exists for: "it turns 'she wrote some code' into 'she wrote code that
-- demonstrably boots', and it is a mechanical gate rather than a habit."
--
-- The gate has existed since 82c715a and enforced nothing. A landing card
-- could be raised, approved and executed for a branch that had never been
-- built, never booted and never run a test — which is the shape of every
-- control this codebase has had to replace: a good capability that nothing
-- required anyone to use.
--
-- KEYED TO THE COMMIT, not to the session. A session can be re-run and a
-- patch re-captured; what was verified is a specific tree, and a verdict that
-- outlived the code it was about would be worse than no verdict. `preflight`
-- compares `sandbox_commit` against the session's current `commit_sha` and
-- refuses when they differ, so a re-run invalidates its own approval.
--
-- The detail column holds the failing stage and its summary, because "the
-- sandbox said no" is not actionable and "the suite failed: 2 suites FAILED:
-- test_x, test_y" is.

ALTER TABLE coding_sessions
    ADD COLUMN IF NOT EXISTS sandbox_status text,
    ADD COLUMN IF NOT EXISTS sandbox_commit text,
    ADD COLUMN IF NOT EXISTS sandbox_detail text,
    ADD COLUMN IF NOT EXISTS sandbox_at     timestamptz;

COMMENT ON COLUMN coding_sessions.sandbox_status IS
    'ok | failed — the boot gate verdict for sandbox_commit. NULL means never '
    'checked, which code_change.land treats exactly like a failure.';
