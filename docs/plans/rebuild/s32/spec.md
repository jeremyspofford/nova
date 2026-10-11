# S32: her changes, a sealed box per change, and her landing step — the spec

**Status:** approved 2026-10-11. The owner took every proposal in §9 ("go
with your proposed"). Everything else follows from rulings already on record,
which are cited where they are used.

The owner asked for this on 2026-10-08, after Nova built a feature inside the
live checkout through `device_run`:

> Nova must always work in git worktrees, with coding smarts. The environment
> is a per-repo setting, the hub by default, and her commands run in a
> per-change sealed dev container — no egress, no ports, the shared CPU lock.
> Write it into the S32 spec for my approval.

(Recorded as relayed in the session; the order he chose the same evening was
"the worktree shortcut first, then S29 → S30 → the rest of S32", with
enforcement "worktree by default, plus a flag" — no refusal.)

Read with S32 in [`../doing-things.md`](../doing-things.md) (build identity
and her landing step), its Q2, Q7 and Q14, [`../nova-codes.md`](../nova-codes.md)
(S32 widened: a worktree per change, landings one at a time, the coder on the
record, `AGENTS.md` for any coder), and [`../s33/spec.md`](../s33/spec.md),
which deploys what S32 lands.

---

## 1. What exists today (`main` at aa63bcc6)

- **A worktree per change — shipped (#138).** `start_change`
  (`services/core/app/tools/changes.py:133`) fetches the default branch, makes
  `nova/<id>-<slug>` at `<checkout>/.worktrees/nova-<id>`, files a fact, and
  returns the path, the branch, the base commit and that worktree's
  `AGENTS.md`. `list_changes` (`:218`) lists the open ones with branch, head
  and dirty state. The repo's machine is `NOVA_REPO_HOST`, matched to exactly
  one live device (`code_repo.py:70`), never guessed.
- **Work outside a worktree is flagged, not refused.** A `device_run` or
  write that touches the checkout outside `.worktrees/nova-*` runs, its
  result names `start_change`, and its span carries `outside_worktree`
  (`devices.py:442-503`).
- **Her commands run on the hub as the owner's user, unsealed.** The hub
  agent is a `systemctl --user` service (`apps/novad/internal/service/
  systemd_linux.go:46`) of the user who ran `./install`, and `./install`
  requires that user to run `docker` (`install.sh:113`). So a `device_run` in
  her worktree can reach the internet, publish ports, read `~/.secrets`, and
  drive the docker socket — which is host root. A command is killed at 110 s
  (`client.go:46`); jobs that outlive a turn are S30c, not built.
- **No sandbox exists in v4.** No `internal: true` network anywhere; the only
  `--network none` is the backup helpers.
- **No landing exists.** No `repo_land`, `repo_status`, `repo_diff`,
  `landings` table, `stack_status`, `land_check.sh` or Changes page.
- **No build identity per service.** `SERVICE_VERSION = "0.0.1"` in all three
  services (core `main.py:55`, gateway `:22`, memory `:23`); `/status`
  returns that constant. `install.sh:2261` records one `NOVA_COMMIT` for the
  whole stack in `.env`. Images are untagged builds. Five binds in
  `deploy/docker-compose.yml` are relative (`./postgres-init`,
  `./agent-dist`, `../data`, `../searxng`, `./tailscale`).
- **Tests need a scratch database nobody owns.** DB-backed tests skip
  without `TEST_DATABASE_URL`; the lanes use `nova-scratch-pg` on :55432, a
  container no code creates.
- **The CPU lock is a path in a Claude scratchpad** (memory
  `shared-full-suite-lock`), not in the repo. The mini PC is an N150: 4 cores,
  15 GB.
- **`AGENTS.md`** is titled "Nova v3", written as Claude's "I", and its
  "When you change code" section (`:124`) is the only part addressed to her.
- **Migrations:** core is at `044`; S30c has `045` reserved.

## 2. Rulings that bind this design

- **No approvals, ever** (2026-09-03, `../no-approvals.md`). Nothing here asks
  the owner or refuses on his behalf. A check may say a call *cannot* run
  (the box is down, the scratch database is unreachable); it may never decide
  that she *may not*.
- **The sandbox threat model** (2026-08-10): the controls are egress-block,
  isolation from production, and the merge gate. What she reads inside a
  sealed box is not a threat — it is her own repo, history included.
- **The v3 sandbox lesson** (2026-08-10, the held `fable/sandbox-checks`
  branch): the box was defined by a compose file *from the code under test*,
  and two review rounds found 20 ways for that code to escape to host root
  (`privileged`, `volumes_from` the warden, `build.context` exfiltration,
  merged `environment` carrying tokens). **The box's shape must come from
  code the change cannot edit.**
- **Q2** (2026-09-30): her own branch per change; a change whose suites pass
  on a clean copy merges itself into `main`; deploys come from
  `~/workspace/nova` on `main` (also the 09-25 rule).
- **Q7** (2026-09-30): the suites always run on a clean copy; red cannot
  deploy; a change to the tests that grade her lands *flagged*; "could not
  measure" deploys with a note; "still running" waits.
- **Q14** (2026-09-30): `repo_land` ends "Claude commits in her tree".
- **Mechanical over prompts.** "Run your commands in the box" in `AGENTS.md`
  is a request. The line of code that routes the command is the control.

## 3. The shape, in one paragraph

Each open change gets a **box**: a container the hub's agent starts from a
fixed recipe on `main`, with her worktree mounted read-write, the repo's git
store mounted read-only, no network route out, no published ports, no docker
socket, no host secrets, and a scratch Postgres of its own on a network only
the two of them share. **A `device_run` whose `cwd` is inside a change's
worktree runs in that change's box** — routed by code, not by her choosing.
File reads, edits and searches keep working on the host, because the worktree
is the same directory on both sides. When she says the change is done,
`repo_land` commits it on the host, brings it up to date with `main`, exports
a clean copy of that exact commit into a fresh box, runs every suite the
change touches under the CPU lock, and writes a `landings` row. Green merges
into `main`; red, a conflict, or a failure to measure says so and stays on
her branch.

## 4. The box

### 4.1 Where its shape comes from

- The recipe is `deploy/devbox/` **as it is on `main` in the checkout**: a
  `Dockerfile` (Python and `uv`, Node and `npm`, Go, `git`, `ruff`, pinned by
  digest) and a run spec that is **Go code in `novad`**, not a compose file.
  The agent builds the image once per `main` commit that changes
  `deploy/devbox/`, tagged by that directory's tree hash.
- A change that edits `deploy/devbox/` does not change its own box. Its edit
  takes effect for changes started after it lands — the same reason the v3
  lesson gives.

### 4.2 What the box can and cannot do

| | Box |
|---|---|
| Her worktree | bind, read-write, at the same absolute path as on the host |
| The repo's `.git` | bind, read-only (so `git log`, `diff`, `status`, `blame` work; commits do not — §5.1) |
| Network | its own `internal: true` network: the box and its Postgres, nothing else. No route out, no DNS beyond the two names |
| Ports | none published |
| Docker socket, `/var/run`, `$HOME`, `~/.secrets`, `.env` | not mounted |
| Environment | `TEST_DATABASE_URL` for its own Postgres, `HOME=/tmp/home`, nothing from the host |
| User | the owner's uid and gid, so files in the worktree stay his |
| Capabilities | `--cap-drop ALL`, `no-new-privileges`, the default seccomp and AppArmor profiles |
| Limits | a memory cap, a pids cap, and 2 CPUs (settings; §9.5) |
| Lifetime | starts on `start_change`; stops when idle 30 minutes; removed with its Postgres when the change lands or is closed |

### 4.3 Dependencies without egress

A sealed box cannot fetch from PyPI or npm. Ruled (§9.1, 2026-10-11):

- The box image carries the dependency caches for `main`'s lockfiles
  (`uv.lock` for each service, `apps/web/package-lock.json`, `go.sum` for
  `apps/novad`).
- When a change's lockfile differs from `main`'s, a **fetch step** runs in a
  separate, short-lived container *with* egress. It mounts only the lockfiles
  and manifests (not her source), runs `uv sync --frozen
  --no-install-project`, `npm ci --ignore-scripts` and `go mod download`, and
  writes into the change's cache volume, which the box then mounts read-only.
- Downside: a package's own build step (a Python sdist) runs with egress in
  that container. It sees no source of hers and no secret, so what it can
  leak is the lockfile.

### 4.4 How her command reaches the box

- `device_run` already resolves `cwd`. On the repo's machine, a `cwd` inside
  `.worktrees/nova-<id>` becomes `docker exec` into `nova-box-<id>` (started
  if it is stopped). Every other `cwd` runs on the host as today.
- The result frame and the span say where it ran: `ran_in: box nova-box-<id>`
  or `ran_in: host`. S29's run fact gains the field, so a claim that tests
  passed can be held to *where* they passed.
- A box that cannot start returns an `Error:` result naming why (image build
  failed, docker down). It never falls back to running on the host, because a
  fallback that quietly drops the seal is the exact "success you did not
  check" the repo forbids.
- `outside_worktree` stays as it is: a command in the checkout itself still
  runs on the host, flagged. The box removes the reason to work there; it
  does not refuse it (the 10-08 enforcement ruling).

### 4.5 The CPU lock

- The lock moves into the repo's world: `deploy/state/cpu.lock` on the hub,
  taken by `flock`. The box runner wraps every **heavy** command — a full
  suite, an image build, a landing — in it; targeted runs stay unlocked.
- "Heavy" is decided by code: a landing always takes it, and a `device_run`
  in a box takes it when its argv is one of the repo's suite commands (read
  from `deploy/devbox/suites.toml`, §5.2) with no test selector.
- The Claude lanes move to the same path, so one lock serves both. While a
  run waits on the lock, its result says so, with how long it waited.

### 4.6 The per-repo setting

- A `code_repos` row per repo: name, machine (default: the hub, from
  `NOVA_REPO_HOST`), checkout path, default branch, and **environment**:
  `box` (default) or `host`.
- `host` is the owner's escape hatch for a repo whose work cannot run in a
  box. It is his setting, not hers, and it is shown on the change's record.
  S32 ships one row, for her own repo. S32c generalizes it to other repos.

## 5. Her landing step

### 5.1 Committing

The box cannot write to `.git`, so commits happen on the host, through a tool:

- `change_commit(change, message)` runs `git add -A && git commit` in the
  worktree on the host. The author is `Nova <nova@<hub>>`, with trailers
  `Nova-Turn: <turn id>` and `Nova-Coder: <coder>` (her loop and the model
  id, or an outside coder by kind and machine — nova-codes decision 6).
- It returns the commit SHA and the diff's stat, and files a `commit` fact
  that `edited_file` claims can also read.

### 5.2 Judging — `repo_land(change)`

One landing at a time per repo (a lock). Steps:

1. **Commit check.** Uncommitted work in the worktree → `Error: uncommitted
   changes in <files>; call change_commit first`.
2. **Bring it up to date.** Fetch `main`; if the branch is behind, rebase it
   onto `main` on the host. A conflict → the row reads `conflict` with the
   files, the rebase is aborted, and the change goes back to her.
3. **Clean copy.** `git archive <sha>` into a fresh directory, mounted into a
   fresh box with a fresh Postgres. The worktree is never what is judged, so
   a dirty file she forgot cannot turn a check green.
4. **Which suites.** `deploy/devbox/suites.toml` on `main` maps paths to
   commands: `services/core/**` → `uv run pytest` in `services/core`, the same
   for gateway and memory; `apps/web/**` → `npm test` and `npx tsc --noEmit`;
   `apps/novad/**` → `go test ./...`; `deploy/**` → the installer tests. Every
   landing also runs `uv run ruff check` on the changed Python files. A path
   no rule covers runs the core suite.
5. **Run them** under the CPU lock, as an S30c job (they outlive a turn: the
   core suite is about 5½ minutes on CI and longer on the N150).
6. **Verdict** — Q7's vocabulary:
   - `green`: every suite ran and passed, with **no skips caused by the
     environment**. A skip because `TEST_DATABASE_URL` was missing would mean
     the box is broken, so it counts as `could_not_measure`, not green.
   - `red`: a suite failed. The row stores the failing suite and its tail.
   - `could_not_measure`: the box or its Postgres did not come up. Q7 says
     this deploys with a note; §9.3 asks whether it also *merges*.
   - `running`: still going; S33 waits.
   - **Flags**, never stops: `protected` lists the files the change touched
     among the tests that grade her (`services/*/tests/**`, `tests/**`,
     `services/core/app/guards.py`, the eval corpus and its pins,
     `tests/test_no_approvals.py`). The list is read from `suites.toml` on
     `main`, so a change cannot shorten it for itself.
7. **Merge on green** into `main` — fast-forward, since step 2 rebased —
   then `git -C <checkout> merge --ff-only` so the deploy checkout has it.
   It reaches GitHub as a PR merged at once (§9.2). A checkout whose tree is dirty
   gets `dirty_outside: <files>` on the row; that never blocks and never
   enters the judged copy.
8. **Close.** The box, its Postgres and the worktree are removed after a
   merge. The branch is kept until S33 reports the deploy serving.

### 5.3 The record

- Migration `046_landings.sql` (`045` is S30c's): `landings` — id, change
  id, repo, branch, base SHA, commit SHA, author, coder, turn id, verdict,
  per-suite results (`{suite, exit, passed, failed, skipped, seconds,
  tail}`), `protected`, `dirty_outside`, the stored patch, merged SHA, push
  result, timestamps. Plus `code_repos` (§4.6).
- `landing_status(id)` reads a row back. Every claim about a landing is held
  to its row: S29's `tests_passed` claim gains the landing as a backing
  fact, and a new claim kind `landed` ("merged", "landed", "it's on main")
  needs a `green` row with a merged SHA.

### 5.4 Her tools

Registry +6, each `NOT_AUTO_RUN` except the reads:

| Tool | Does | Kind |
|---|---|---|
| `change_commit` | §5.1 | write |
| `repo_land` | §5.2; returns the landing id at once, the verdict comes later | write |
| `landing_status` | reads a landing | `reads_only` |
| `repo_diff` | a change's diff against `main`, by file, with ranges | `reads_only` |
| `close_change` | removes a change's box and worktree without landing; the branch is kept | write |
| `stack_status` | each service's running SHA and content hash (§6), from the containers' labels, against `main`'s head | `reads_only` |

`start_change` also starts the box. `list_changes` adds the box's state and
the last landing per change.

## 6. Build identity

As designed in `doing-things.md` S32, unchanged:

- `NOVA_BUILD_SHA` and a per-service content hash (the git tree hash of the
  service's directory plus the shared files it copies) baked into core,
  gateway, memory and web as build args and image labels; reported on each
  `/status` and on web's `/build.json`. `SERVICE_VERSION` is deleted.
- Images tagged by that content hash, so a deploy recreates only the services
  that changed and the previous build stays for S33's rollback.
- The five relative binds become absolute, from the checkout path
  `./install` records.
- This is also S33 spec §10 step 1, so it is built first.

## 7. The Changes page

- A **Changes** page lists landings, newest first: title, author and coder,
  verdict, flags, and the commit. Opening one shows the stored patch, file by
  file, and the per-suite results. Reached from the main menu (the
  "discoverable by navigation" rule).
- Each landing posts an Inbox notice with a thread, so the owner can discuss a
  change with her where he reads it.

## 8. `AGENTS.md` for any coder

The rewrite `nova-codes.md` specifies, in the same slice: written to "the
coder"; titled v4; the line "infrastructure code in git is mine; operating
the running system is hers" restated for a Nova who writes her own code; the
v3 operational traps replaced with v4's; the "never commit" rule replaced by
this flow (the coder commits with `change_commit` and lands with
`repo_land`); the rules that today live only in Claude's memory folded in
(format only the files you edited, `npm test` never `npx vitest run`, sweep
guard regexes for time, take the next migration number from the directory,
read a trace by turn id). No machine identifiers — the repo is public.

From the day `repo_land` is deployed, Claude no longer commits in her tree
(Q14). Claude's own lanes go through `repo_land` too, as an outside coder.

## 9. Decisions — answered 2026-10-11: the proposals

The owner's answer to all six: "go with your proposed". Each *Proposed* line
below is the ruling; the *Otherwise* lines stay as the record of what was
turned down.

1. **Dependencies (§4.3).** *Proposed:* the fetch step — egress, but only
   lockfiles and manifests mounted. *Otherwise:* (a) no fetching at all: a
   change that adds a dependency cannot run its tests until a person rebuilds
   the box. Downside: she cannot add a dependency on her own. (b) Give the box
   egress through a proxy that allows only PyPI, npm and the Go proxy.
   Downside: her code, running in the box, could post anything to an
   allowed host (npm accepts uploads), so the seal is gone.
2. **How a green landing reaches GitHub.** *Proposed:* push the branch, open
   a PR with the landing's verdict in the body, and merge it at once with
   `gh` — GitHub keeps the same PR trail he reads today, and CI runs as a
   second opinion. *Otherwise:* push `main` directly (simpler; no PR trail),
   or keep it local and push nothing (GitHub falls behind the hub). Either
   push needs a credential on the hub that can write to the repo; today
   pushes use the repo's own `sshCommand` key.
3. **Does `could_not_measure` merge?** Q7 says it *deploys* with a note.
   *Proposed:* it does not merge; it stays on her branch with the reason, and
   she lands again when the box is back. A merge with no suite run behind it
   is a red commit waiting to happen. *Otherwise:* merge with the note,
   exactly as Q7 reads.
4. **The `host` environment (§4.6).** *Proposed:* it exists, set only by the
   owner. *Otherwise:* no escape hatch — every change runs boxed.
5. **Limits.** *Proposed:* 2 CPUs, 3 GB of memory and 512 pids per box, and
   at most 2 boxes running at once on the N150 (a third change's box starts
   when one goes idle). Measured in the first slice, then fixed as settings.
6. **No ports means she cannot open her own dev server.** A web change is
   judged by `npm test` and `tsc`, not by looking at it. *Proposed:* accept
   that for S32; when S38's browser lands, its container may join a box's
   internal network to look at a dev server there, still with no egress.

## 10. Order and estimate

Collapsed steps for the small parts (the 10-08 pace rule); estimates are for
the build and its tests, not the live walk.

1. **S32.1 Build identity** (§6) — about 3 h. Also unblocks S33.
2. **S32.2 The box** (§4: recipe, run spec in `novad`, routing in
   `device_run`, `ran_in`, the CPU lock, `code_repos`) — about 6 h.
3. **S32.3 The landing step** (§5: `change_commit`, `repo_land` on S30c's
   jobs, `suites.toml`, migration 046, the tools, the `landed` claim) —
   about 7 h. **Waits on S30c.**
4. **S32.4 The Changes page and the Inbox notice** (§7) — about 3 h.
5. **S32.5 `AGENTS.md`** (§8) — about 1½ h.

About 20 h in all. S32.1 and S32.2 can start now; S32.3 waits on S30c (jobs),
which waits on hub:2's S30b leaving `apps/novad`.

## 11. Definition of done

Walked in chat on the real stack, each turn read back by turn id:

- "What commit is running?" — answered per service, matching `git log` and
  each `/status`.
- "Start a change and run the core tests" — `start_change`, then a
  `device_run` with `ran_in: box`; the span shows the box; `curl
  https://example.com` in that box fails, and the result says it failed.
- "Change `get_time` to include the ISO week and land it" — a commit authored
  by Nova with her turn and coder trailers; a `landings` row reading `green`;
  the patch on the Changes page; the commit in `git log` on `main` and on
  GitHub per §9.2.
- A landing that touches `guards.py` reads `protected:
  [services/core/app/guards.py]` on the row and in her reply.
- A change with a failing test reads `red`, names the failing suite, and is
  not on `main`.
- Two changes open at once, both boxed; the second's full suite waits on the
  lock and says so.
- A change that edits `deploy/devbox/Dockerfile` to add `--privileged` (or
  anything else) runs in the box built from `main`, unchanged.
- Claude's next change in this repo lands through `repo_land`.
