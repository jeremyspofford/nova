# The Claude loop: Claude builds Nova while the owner is away

Status: SPEC, 2026-10-06. Nothing is built.

This is dev tooling. It is not a Nova feature and not a slice. Nova running her
own development is `nova-codes.md` (S29 onward). This loop is only Claude
working through the roadmap until that exists. The owner ruled that Nova
taking the loop over is out of scope for now, so nothing here is designed for
a handover.

## The ask, and the owner's answers (2026-10-06)

The owner asked how Claude can keep working on Nova while he is away, without
being told what to do next. Three answers:

1. **Pre-approved means a merged spec.** A slice whose spec is on `main` may be
   planned, built, merged, deployed and walked with no further go.
2. **Push notifications** are how the loop reaches him. "we're not concerned
   with nova being able to do this loop yet, right now it's just claude looping
   through the tasks to build nova."
3. **No budget.** "just go until it hits the usage window." When the window
   resets, the loop picks up again.

## 1. The engine

A runner script, `tools/claude-loop/run`, runs as a systemd `--user` service on
the mini PC. It loops:

1. If `~/.nova-loop/STOP` exists, exit 0. Touching that file is how the owner
   stops the loop.
2. Run one **tick**: `claude -p` in `~/workspace/nova` with the prompt in
   `tools/claude-loop/tick.md`. Every tick starts with a fresh context. The
   trackers on disk are the only memory, which is how epic-tdd-loop already
   works.
3. Read how the tick ended:
   - **Usage limit.** Sleep until the reset time printed in the error. If no
     reset time can be parsed, sleep 30 minutes and try again. This is the
     only budget.
   - **Clean exit.** Start the next tick right away.
   - **Any other failure.** Retry. After 3 in a row, send a push with the last
     lines of output and exit non-zero. A crash loop must never look like
     work.
   - **Nothing eligible to work on.** The tick says so, and the runner sleeps
     an hour before checking again.

The runner does not set an effort level. The session gets whatever the owner's
config sets.

A `/loop` session under the daemon was rejected for two reasons. Its context
grows across ticks, and a dead daemon takes the loop with it. Cloud routines
(`/schedule`) were rejected because they have no stack and no GPU, and done
means the running app.

## 2. The queue

There is no separate queue file, because a list someone maintains goes stale.
Each tick derives the queue from three sources:

- **Order:** "The order of work" in `docs/plans/rebuild/ROADMAP.md`, plus the
  order notes it links to.
- **Eligible:** the slice's spec is on `main` and has no open owner question.
- **Not claimed:** a slice the ROADMAP marks in progress belongs to another
  session. Today that is S42b (hub:1), and S37a and S38 (hub:2). The loop
  doesn't touch a claimed slice unless `~/.nova-loop/state.md` records that
  the loop itself claimed it.

The loop works one lane at a time, in `.worktrees/loop-<slice>`, and takes the
first eligible slice. Before it starts building, it adds a line to the
ROADMAP's state cell for that slice ("In progress: the Claude loop") as part
of the first PR, so other sessions can see the claim.

**When the next slice has no spec,** the loop drafts one. It opens the spec as
a PR, `spec/<slice>`, and never merges it. The owner's open questions go at
the top of the PR. The loop sends a push ("spec ready: <PR>, N questions")
and moves on to the next eligible slice. **His merge of a spec PR is the
approval.** This follows from answer 1. Without it the queue drains in a day,
because most slices after S42b (provider balances, S30b, S29 onward) have no
merged spec yet.

## 3. One tick

`tick.md` tells the session to do the following, in order. Each step ends the
tick early if the usage window closes. The next tick resumes from disk.

1. **Recover.** Read `git status` in `~/workspace/nova` and in every
   `.worktrees/loop-*`. Read `~/.nova-loop/state.md`, and the `NEXT:` line of
   every open tracker in `.worktrees/loop-*/.epics/`. A dirty tree with no
   tracker step to explain it is a crash: report it by push and stop the
   tick. Never `git stash`, `git add -A`, `reset` or `clean`.
2. **Answers.** For each blocked item, read the owner's new comments on its
   PR. If one answers the question, copy the answer into the tracker's
   Request and clear Blocked.
3. **Work.** If a loop epic is open and not blocked, advance it with
   epic-tdd-loop until EPIC DONE, a block, or the end of the window. If no
   epic is open, take the next queue item from section 2. That means creating
   the worktree and the tracker for a specced slice, or drafting the spec for
   an unspecced one.
4. **Ship**, for an epic at EPIC DONE:
   1. Open the PR and wait for CI to go green. Merge with `gh pr merge`; the
      allow rule is already in `.claude/settings.local.json`.
   2. Pull `main` in `~/workspace/nova`, rebuild and restart the changed
      services under the shared full-suite lock, and confirm each one is
      healthy.
   3. **Walk** the slice: ask her the slice's walk question in chat through
      the real API, as the owner's session, then read `turn_spans` by
      turn id.
   4. If the walk fails, add a fix task to the same epic (the EPIC VERIFY
      rule) and continue.
   5. If the walk needs the owner (his phone, his hardware, a game off the
      GPU), record "walk owed" in the ROADMAP and in the push. Don't block on
      it.
5. **Record.** Update the ROADMAP row and `~/.nova-loop/state.md`, then send
   one push: shipped, blocked, spec ready, or idle.

## 4. Blocks

When a question only the owner can answer comes up:

1. Post it as a comment on the slice's PR. Open a draft PR if none exists yet.
2. Send a push with the question and a link to that comment.
3. Set the tracker's Blocked line and move on to the next eligible slice.

The owner answers by replying on the PR, from his phone or anywhere else. The
next tick reads the reply (section 3, step 2).

These count as blocks:

- Any choice that a spec marks as the owner's.
- A pinned suite (`test_tools_registry`, `test_eval_corpus`,
  `test_no_approvals`) going red for a reason the slice's spec doesn't
  explain.
- The same step failing its check twice in a row, or 3 VERIFY FAILs on one
  task, which is epic-tdd-loop's existing stop rule.
- CI red on `main` from something other than the loop's own PR.

## 5. Guardrails

- **The STOP file.** It is checked before every tick, and once more before
  every merge.
- **No destructive git.** No force push, no `git stash`, no `reset --hard`,
  no `clean`, and no deleting a branch the loop didn't create. Stage files by
  path only.
- **Lanes are separate.** The loop never edits another session's worktree.
  Deploys and CPU-heavy jobs take the shared full-suite lock, the same one the
  hub sessions use.
- **Every push is true.** A shipped push needs a merged PR, green CI, healthy
  services and a walk verdict. Any of those it couldn't check is named in the
  push as unchecked.
- **Effort.** The loop always gets the owner's configured effort level, even
  if the runner is ever launched from the daemon, because the runner never
  sets its own.

## 6. Build plan

| Task | What | Done when |
|---|---|---|
| T1 | `tools/claude-loop/run` + the systemd unit | Tested against a fake `claude` binary: STOP exits; a usage-limit error sleeps until the parsed reset (and 30 minutes when none parses); 3 failures send a push and exit non-zero; a clean exit starts the next tick |
| T2 | Push from a headless tick | A `claude -p` session's push reaches the owner's phone, and he confirms it. If it can't, the loop does not start, and the delivery choice goes back to him. There is no silent fallback. |
| T3 | `tools/claude-loop/tick.md` | One supervised tick in a live session, on a real queue item (the provider-balances spec draft): it recovers, picks the right item, opens the spec PR and pushes |
| T4 | Enable the service | It runs unattended, and its first ticks are read back from `~/.nova-loop/state.md` and the PRs |

## Open for the owner

- **Spec drafting (section 2).** Should the loop draft specs for unspecced
  slices as unmerged PRs? The recommendation is yes. Without it the loop runs
  dry after one or two slices. On 10-06 he said no to a parallel session
  starting S30b's spec, so this needs his yes.
