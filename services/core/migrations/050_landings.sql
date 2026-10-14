-- S32.3 (her landing step): one row per repo_land — what was judged, how,
-- the verdict, and what was published (docs/plans/rebuild/s32/spec.md §5.3,
-- app/landings.py, one writer).
--
-- The next free number after 049_tool_results (046 code_repos, 047
-- wake_attempts, 048 device_jobs, 049 S38b's tool_results, which landed
-- first — renumbered 049 -> 050, 2026-10-13).
--
-- A row is written `running` when repo_land starts and is moved to exactly
-- one terminal verdict (green | red | could_not_measure | conflict), never
-- rewritten. Every claim about a landing is held to its row: `landed` needs
-- a green row WITH a merged SHA, and the CHECK below is the line that
-- refuses a merged SHA on anything but a green row, whatever code tried.
--
-- `repo` is code_repos.name with no foreign key, so a renamed or removed
-- repo keeps its landing history.
--
-- Re-runnable: its test executes it a second time.

CREATE TABLE IF NOT EXISTS landings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- her change (the worktree .worktrees/nova-<change_id>)
    change_id       text NOT NULL CHECK (change_id ~ '^[0-9a-f]{6}$'),
    repo            text NOT NULL,
    branch          text NOT NULL,
    -- origin/<main> the change was rebased onto, and the commit judged
    base_sha        text CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    commit_sha      text CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    -- provenance from the commit (author, Nova-Coder trailer), never a gate
    author          text,
    coder           text,
    -- the turn that called repo_land (provenance, never a principal)
    turn_id         uuid REFERENCES turns (id) ON DELETE SET NULL,
    verdict         text NOT NULL DEFAULT 'running' CHECK (verdict IN (
        'running', 'green', 'red', 'could_not_measure', 'conflict'
    )),
    -- where a running landing is; where a finished one stopped
    stage           text,
    reason          text,
    -- per suite: {suite, command, exit, passed, failed, skipped, seconds, tail}
    suites          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(suites) = 'array'),
    protected       text[] NOT NULL DEFAULT '{}',
    dirty_outside   text[] NOT NULL DEFAULT '{}',
    conflict_files  text[] NOT NULL DEFAULT '{}',
    patch           text,
    patch_truncated boolean NOT NULL DEFAULT false,
    merged_sha      text CHECK (merged_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    pr_url          text,
    push_result     text,
    -- the clean copy's id: .worktrees/nova-<judge_id>, box nova-box-<judge_id>
    judge_id        text CHECK (judge_id ~ '^[0-9a-f]{6}$'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- a running landing has not finished; a finished one says when
    CONSTRAINT landings_finished_iff_terminal CHECK ((verdict = 'running') = (finished_at IS NULL)),
    -- only a green landing is ever merged
    CONSTRAINT landings_merged_only_green CHECK (merged_sha IS NULL OR verdict = 'green')
);
CREATE INDEX IF NOT EXISTS landings_by_change
    ON landings (change_id, created_at DESC);
CREATE INDEX IF NOT EXISTS landings_running
    ON landings (created_at) WHERE verdict = 'running';
