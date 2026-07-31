-- Coding delegation: the repos Nova may work on, and the sessions she runs.
-- docs/plans/acp-coding-delegation.md phase 1.
--
-- WHY A GIT URL AND NOT A HOST PATH. The plan says "operator-registered repos
-- mounted into THIS container only". Phase 0 (2026-07-31) changed what that
-- can safely mean: ACP cannot confine the agent, so the coder container is the
-- only boundary, and every host mount is a hole in it. Three transports were
-- weighed:
--
--   per-repo read-only bind   compose binds are static; a runtime registry
--                             would need a service recreate per registration
--   read-only parent dir      what mcp-runner's own compose comment forbids —
--                             "never the parent of the repo, which holds .env"
--   clone from the remote     no host mounts at all
--
-- The third wins on a fact that decides it: `git clone` copies only TRACKED
-- content, so `.env` and every other gitignored secret cannot cross into the
-- workspace by construction, rather than by a filter someone maintains. It is
-- also the transport phase 9 (branch push, real PRs) needs anyway, so the
-- runtime does not change underneath us later.
--
-- The cost, stated: the agent works from a COMMITTED base and cannot see
-- uncommitted work. That is a real limitation and arguably the right one — the
-- deliverable is a branch the operator merges, so starting from a commit is
-- what makes the diff reviewable.
--
-- `auth_secret` names a row in `secrets` rather than holding a token, per the
-- store's own rule (reference, don't mirror). NULL is the normal case: a public
-- repo clones with no credential at all.

CREATE TABLE IF NOT EXISTS workspaces (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text UNIQUE NOT NULL,
    git_url        text NOT NULL,
    default_branch text NOT NULL DEFAULT 'main',
    -- name of a `secrets` row for private clones; NULL = public, no credential
    auth_secret    text,
    enabled        boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One delegated coding task. `task_id` is nullable and unconstrained on
-- purpose: docs/plans/coding-team-pipeline.md adds a stage machine above this
-- layer, and the plan asks for the column now so that lands as a foreign key
-- rather than as a migration of live rows.
--
-- `broker_session_id` is the sidecar's own id. It is separate from `id`
-- because the broker holds sessions in memory and loses them on restart,
-- while this row is the durable record — a session whose broker id no longer
-- resolves is a session that died, and that is a fact worth keeping rather
-- than a row worth deleting.
CREATE TABLE IF NOT EXISTS coding_sessions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      uuid REFERENCES workspaces(id) ON DELETE SET NULL,
    task_id           uuid,
    broker_session_id text,
    task              text NOT NULL,
    mode              text NOT NULL DEFAULT 'default',
    -- starting | running | done | failed | killed — the broker's vocabulary.
    -- `killed` covers both an operator stop and the wall clock; `error` says
    -- which, because telling an operator their own stop was a "failure" is a
    -- lie the broker used to tell (fixed 2026-07-31).
    state             text NOT NULL DEFAULT 'starting',
    branch            text,
    commit_sha        text,
    diffstat          text,
    error             text,
    requested_by      text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coding_sessions_recent_idx
    ON coding_sessions (created_at DESC);
