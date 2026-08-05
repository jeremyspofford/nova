-- Migration 101: she clones HIS repository, not GitHub.
--
-- The blocker that stopped phase 4 from working end to end, found by running
-- it rather than by reading it. `workspaces.git_url` pointed at
-- https://github.com/jeremyspofford/nova.git, so the coding agent cloned
-- GITHUB — while Jeremy's actual repository was three commits ahead and
-- unpushed. Asked to edit `frontend/src/components/settings/home.tsx`, created
-- that same day, the agent received a clone that did not contain the file,
-- changed nothing, and finished `done` with no commit, no commands and no
-- denials.
--
-- A silent no-op is the worst shape a failure can take: nothing errored, and
-- the session looked exactly like a session that had decided the work was
-- already complete.
--
-- `git-landing` already holds the repository (it is the only container with
-- write access) and now also serves it READ-ONLY over `git daemon` on the
-- compose network. So:
--
--   * she always works from his real HEAD, by construction rather than by
--     anyone remembering to push;
--   * `git am` in the landing step applies against the tree the patch was
--     written on, instead of a tree that may be arbitrarily behind;
--   * nothing can push into his repository through that port — `git daemon`
--     does not enable `receive-pack` unless told to, and it is not told to.
--     Verified: `git push` from the coder answers "service not enabled".
--
-- Reversible in one UPDATE if he ever wants her working from the published
-- repository instead — which is a real preference, not a mistake, on a day
-- when main and origin/main agree.

UPDATE workspaces
SET git_url = 'git://git-landing/repo',
    updated_at = now()
WHERE name = 'nova'
  AND git_url = 'https://github.com/jeremyspofford/nova.git';
