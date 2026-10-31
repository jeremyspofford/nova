-- Coding through chat (M10c). A coding run: the plan a coding request in chat becomes, carried by a
-- chain of Work Ledger tasks for the `coding` worker (write, check, merge; update when the branch
-- moved). Not replicated: its worktree, Nova's copy of the repository and the preview are on this
-- machine (workers/coding/).
--
-- `repo` is the real path of the person's repository and `branch` the branch a merge moves.
-- `base` is the commit the change was made (or brought up to date) against, `head` Nova's commit of
-- it on nova/<id>; `tree_digest` is Nova's own walk of that commit's files. `changes` and `diff` are
-- what the person reviews. `test` and `preview` are Nova's records of the check step. `tasks` lists
-- every task of the run, in order: [{step, round, id}].
CREATE TABLE coding_run (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  agent TEXT NOT NULL,
  test_command TEXT NOT NULL,
  preview_command TEXT,
  editable TEXT,
  privacy_mode TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  round INTEGER NOT NULL,
  base TEXT,
  head TEXT,
  tree_digest TEXT,
  changes TEXT,
  diff TEXT,
  test TEXT,
  preview TEXT,
  tasks TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX coding_run_by_state ON coding_run (state, created_at);
