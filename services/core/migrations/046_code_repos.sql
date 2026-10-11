-- Her repositories as rows (S32.2, docs/plans/rebuild/s32/spec.md §4.6).
--
-- One row per repository she changes. The 'nova' row is written at every core
-- start from what ./install recorded (NOVA_REPO_HOST, NOVA_CHECKOUT,
-- NOVA_REPO_BRANCH — app/code_repos.sync_from_env); that sync never touches
-- `environment`. `environment` is where her commands in a change worktree run:
-- 'box' (the sealed per-change container, the default) or 'host' — and only
-- the owner sets it, through PUT /api/v1/code-repos/{name}. No tool writes it.
--
-- Number: 045 is reserved for S30c; S32.3's landings table takes 047.
CREATE TABLE code_repos (
    name           text PRIMARY KEY,
    -- The hostname of the machine that holds the checkout (a device row's
    -- hostname, as novad reports it).
    machine        text NOT NULL,
    -- The checkout's absolute path on that machine.
    checkout       text NOT NULL,
    -- NULL = unrecorded: a change then starts from the machine's origin/HEAD.
    default_branch text,
    environment    text NOT NULL DEFAULT 'box' CHECK (environment IN ('box', 'host')),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
