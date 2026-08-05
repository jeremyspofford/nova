# The self-improvement loop — she changes herself, and proves it before he looks

Authored 2026-08-05 from Jeremy's twelve steps, given verbatim below. This is
the umbrella plan; `sandbox-instance.md` is its steps 7 and 10, and phase 4 of
the autonomy lane (`git-landing`) is how anything reaches his repo.

## The flow, as he specified it (LOCKED)

1. Clone her repo, or work in a worktree — whatever safely isolates the code.
2. Spec out the changes.
3. Write tests for those changes.
4. Write code to pass those tests.
5. Loop 3 and 4 until the task is done.
6. Verify completion of the task.
7. Deploy a sandbox Nova (or a sandbox of the service being changed).
8. Back up Nova's data from production.
9. Import production data into the sandbox database.
10. Test thoroughly — integrations, the changes specifically, and a full suite
    of QA and integration tests, before accepting the change.
11. Review: the change, its tests, end-to-end, integration, QA.
12. If it fails, back to 2. Otherwise notify completion with a URL to try it,
    and plainly explain the change and the reason for it.

## What already exists

More than half of it, which is the reason this is worth writing down now.

| step | today |
|---|---|
| 1 | `delegate_coding_task` clones into a private volume. **Already the safer option** — a git worktree's `.git` is a pointer into the parent repo, which is not a portable containment unit (the compose comment on the `coder` service says exactly this). |
| 3–4 | The coding agent writes and runs tests, one shot. |
| 6 | `tests/run_all.py`, 72 suites. |
| 8 | `backup_snapshot` / `backup_coverage` — a real bundle, with a coverage gate that refuses to produce an incomplete one. |
| 9 | `backup_restore` / `backup_apply`. |
| 12 (land) | `git-landing` — applies a patch to a `nova/<slug>` branch, never main, never pushes. |
| durability | `task_steps` — the loop can run across turns, survive a restart, and stop to ask him one thing. |

## What does not exist, stated plainly

**Step 5 — the loop.** `delegate_coding_task` is one shot: it runs once and
produces a branch. There is no iteration and, more importantly, no stopping
condition. A loop needs a bounded retry count and a budget ceiling or it
grinds until someone notices.

**Step 10 — the QA and integration suite.** This is the largest missing piece
and it should not be glossed. The 72 suites are unit-and-module level; almost
none drive the real UI or a real turn end to end. Step 10 as written assumes a
body of tests that has to be built first, and building it is its own lane.

**Step 11 — review by whom.** If she reviews her own change it is self-review
and worth little. It needs an independent reader: a different agent, ideally
on a different model, given the diff and the spec and asked whether one
implements the other. His look at the diff on the landing card stays the last
gate.

**Step 6 — verify against what.** "Verify completion" only means something if
step 2's spec is checkable. Same discipline `propose_goal` already enforces:
a finish line the operator could confirm, not a wish.

## The one amendment I'd argue for

**Steps 8 and 9 as written conflict with the sandbox plan, and I think the
sandbox plan is wrong.**

`sandbox-instance.md` says memory should be seeded, never copied, because a
sandbox runs model-authored code. Jeremy's flow says to import production
data, and he is right about the reason: a sandbox seeded with synthetic notes
tests a system nobody uses. Retrieval behaviour, clustering, the brain graph,
compaction — all of it is shaped by the real corpus, and none of it is
exercised by a fixture pack.

So: **import production data, minus the credentials.** Four tables carry
things that must never exist in a second stack, and the reason is different
for each:

| table | why it is excluded |
|---|---|
| `secrets` | encrypted, but the sandbox would hold the key too; a sandbox that can spend his credentials is not a sandbox |
| `llm_providers` | API keys — a runaway loop in the sandbox bills his account |
| `push_subscriptions` | a test run pushing to his phone |
| `user_profiles` | voiceprints and personal facts about his household, in a stack running code a model wrote |

Everything else — conversations, memory, agents, tools, rules, automations
(seeded **disabled**), goals, recommendations — copies verbatim, because that
is what makes the test real.

`backup_coverage` already knows how to argue about what a bundle must contain;
this is the same list read in the other direction, and it belongs beside that
module rather than in a new one.

## Two bounds this needs, that the twelve steps do not mention

**A retry ceiling on step 12.** "If fails, go back to 2" with no limit is a
loop that can run all night. Three attempts, then it stops and reports what it
tried — which is more useful to him than a fourth attempt anyway.

**A budget ceiling.** Each pass is a coding agent, a sandbox stack, a
production-sized data import and a test suite. That is real money and real
disk. The loop should carry a number he set and refuse to start a pass that
would exceed it.

## What stays his

Landing. `git-landing` puts her work on a `nova/<slug>` branch and returns his
working copy to where it was; merging to `main` is his. Step 12's "notify with
a URL" is the sandbox preview, not a merge notification — he tries it, then
decides.

That is not a limitation to remove later. A loop that could merge its own code
into `main` has no point at which a person disagrees with it.

## Order I would build it

1. **Step 5, the loop** — bounded iteration around the existing coding agent,
   with the retry and budget ceilings. Smallest piece, and everything else is
   pointless without it.
2. **Step 7, the boot gate** — `sandbox-instance.md` phase 1. Ephemeral stack,
   own database, migrations + boot + suite.
3. **Steps 8–9, scrubbed import** — reuse `backup_snapshot`/`backup_apply`
   with the exclusion list above.
4. **Step 11, independent review** — a reviewer agent on a different model,
   given the spec and the diff.
5. **Step 10, the QA suite** — the big one, and best grown against real
   changes rather than written up front.
6. **Step 12, the preview URL** — `sandbox-instance.md` phase 2.

Related: `sandbox-instance.md`, `coding-team.md` (ROADMAP #33),
`self-improvement.md` (ROADMAP #36).
