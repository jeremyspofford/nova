# 10 — Coding Agent (Code Mode)

Code mode is an agentic software-engineering surface built on the same runtime as Work, with
a coding toolset and an environment binding. It covers repo-aware editing, diff review,
terminal execution, browser verification, and local, cloud, remote and device environments.

Nova runs one runtime and one policy engine for every mode (ADR-076). It does not embed or
download a separately versioned third-party coding engine. External coding agents are reachable
only through P2 adapters that route every permission request to Nova's policy engine and run
inside a Nova sandbox, with their changes shown as Nova diffs (FR-203).

## 1. Session model (FR-061)

A **code session** is a `thread(mode='code')` plus a `code_session` row binding:

- **Environment**: `local` | `cloud` | `ssh` | `wsl` | `container` | `device` (FR-062).
- **Project folder / repo** (one or more for cloud).
- **Permission mode** (FR-063): `manual`, `accept_edits`, `plan`, `auto`, `bypass`.
- **Model + reasoning level** (or a preset, FR-221).
- **Git worktree/branch** (isolated per session when parallel).
- **Panes layout** (chat/diff/browser/terminal/editor), persisted per session.

Sessions run in parallel and are independently listed in the sidebar with the shared status
(Running, Needs input, Ready, Blocked; FR-215), unread indicators, and "Needs input" first
(`Ctrl/Cmd+Alt+A`).

*As shipped in M5 (ADR-092).* Code mode (`/code`) lists sessions with title, folder, branch (and
an uncommitted-changes note), mode, status chip and last update, Needs input first. **New
session** (also `/code?new=1`) takes a project folder or a folder path on the Hub, the
environment, the model, the permission mode, an optional title and whether to use a worktree. A
session is a thread with mode `code` plus a `code_session` row; it is Blocked when its
environment is down or its folder is missing. Session folders refuse `/`, system folders, the
home folder and its ancestors, the data folder (inside or around it), credential locations and
`.git`, `.nova` or `.agents`. The session's turns run in the one chat loop (ADR-076); its tools
and the gate both use the session folder as the root. Routes: `GET`/`POST /code/sessions`
(`?archived=`), `GET`/`PATCH /code/sessions/:id`, and `GET /environments`. Code sessions have no
time, token or cost budgets in M5; each turn keeps the 200-step backstop. Layouts per session,
side questions and session handoff are not in M5.

## 2. Environments (FR-062)

```ts
interface Environment {
  id: string;
  kind: 'local'|'cloud'|'ssh'|'wsl'|'container'|'device';
  label: string;
  connection: LocalConfig | SshConfig | WslConfig | CloudConfig | ContainerConfig | DeviceConfig;
  health: { status: 'ok'|'degraded'|'down'|'unknown'; checkedAt: string; detail?: string };
}
```

- **Local**: sandboxed host execution within the project root.
- **Device**: any registered device running `novad` (`docs/23`). The session reaches files and
  processes only through `novad` operations under the device's grants: scoped directory
  listing, folder-access requests, staged-then-committed writes, and exposure of the device's
  local stdio MCP servers (FR-210).
- **Cloud**: remote workspace created from a repo + setup script; persists between runs;
  continues when the laptop is offline (FR-071).
- **SSH**: Nova installs the `novad` helper on the remote host (user level, under
  `~/.nova/remote/`), starts it over the SSH connection, and talks to it through a Unix socket
  with mode 0600 forwarded over that connection. The socket still requires a token (FR-192).
  The helper build is verified by signature before it starts and upgraded when the Hub needs a
  newer version. SSH keys and passwords live in the keychain, never in config files. The agent
  runs remotely; reattach shows buffered output (FR-078).
- **WSL**: runs inside a chosen WSL distro through the same helper path.
- **Container**: rootless podman container from a recipe.

**Saved environments**: each environment is created once, saved, reused across sessions,
health-checked, and selectable per session. Cloud environments pin a machine image and setup
script; rebuilds are explicit.

*As shipped in M5 (ADR-092).* There is one environment, the local Hub ("This Hub"). Its health is
`ok`, or `degraded` when Git or the sandbox is missing; it is never `down`. Exec tools, tests and
terminals run in the container sandbox (ADR-090) with the session folder mounted. Device, cloud,
SSH, WSL and container environments come later.

*As shipped in M6 (ADR-093).* Environments are saved in `environment` (`/api/v1/environments`),
health-checked on request and every 5 minutes while sessions use them; the local Hub stays the
default. Kinds:

- **container**: an image (a reference without shell syntax) and an optional setup script that
  runs once per session in the session folder, network off, at most 30 minutes; the session works
  on the Hub folder and its commands run in the image.
- **ssh**: a host where Nova reaches the `novad` helper; the key or password goes to the keychain
  (`secret://code/environment/<id>/credential`), never into a row or a response; a change of host,
  user or auth method needs a new credential. The M6 Hub binds no SSH transport, so SSH
  environments check `down` and answer `capability_missing` `{reason: no_ssh_transport}`.
- **wsl**: a distro on a Windows device. The device connection has no WSL operations yet, so every
  device answers `not_windows`.
- **device**: a machine running `novad` (`docs/23`); the session reaches its files and processes
  only through `novad` under the session's own grants. `verified` means the device is active and
  needs no update, until signed builds arrive.

Commands of SSH, WSL and device sessions run on that machine under its user, not in a container
(their sandbox reports no substrate). `novad` owns their processes and buffers the newest 1 MiB of
output, so a dropped connection is reattached from the stored offset
(`/environments/:id/processes/:processId/output?offset=`). These sessions have no Hub-side change
capture yet: changes list empty and review, commit, branch, push, symbols, refs and the `git.*`
tools answer `capability_missing` `{reason: remote_environment}`; auto-verify runs only on request
there. Mode checks read the sandbox the session's commands run in: Bypass is never available on
another machine (SSH, WSL, device); a container environment uses its own sandbox, a local one the
Hub's. Container environments' sandboxes reach the network only through the egress proxy (none
without it); `NOVA_SANDBOX_NETWORK=open` does not apply to them. Cloud and VM environments are not
offered.

## 3. Permission modes (FR-063)

Each mode is a preset over two axes (ADR-059): an **approval policy** (when Nova asks) and a
**permission profile** (what the sandbox allows, FR-190). The policy names, their meaning and
this mapping are defined in `docs/12` §2.1; the engine evaluates only the two axes, and the
mode name (`PolicyContext.preset.permissionMode`: `manual`, `accept_edits`, `plan`, `auto`,
`bypass`) is recorded for display and audit.

| Mode | Approval policy | Permission profile | Behaviour |
| --- | --- | --- | --- |
| **Manual** | `ask_always` | `workspace` | Asks before every action that is not read-only and not allowed by a rule or grant; edits show the diff first. Default for new local sessions |
| **Accept edits** | `defaults` + `autoAccept: ['file_edit']` | `workspace` | File edits inside writable roots are allowed and captured as diffs; everything else follows per-tool defaults and rules, so commands ask unless a command rule (FR-191) allows them |
| **Plan** | `ask_always` | `read-only` | Read and explore only; propose a plan; no source edits. Per-session only |
| **Auto** | `review` | `workspace` | Pre-approvable actions inside the profile are allowed; every consequential one goes to the auto-reviewer (FR-085), which can only tighten (to ask, handoff or deny). Cannot be selected while no reviewer model is configured; fails closed; can be disabled by policy |
| **Bypass** | `never_ask` | `full` | An `ask` that comes from a tool default becomes `allow`; an `ask` from a user rule or managed policy, and the `confirm_at_action` and `handoff_required` tiers (FR-189), still reach the user. Only on a VM or container substrate (FR-195); gated by settings and policy |

Rules:

- Switchable mid-session via the composer's mode selector.
- Remembered per folder (except Plan).
- Managed policy can disable modes (FR-106).
- Protected paths (`.git`, `.nova`, `.agents`, credential locations) stay read-only or denied
  inside writable roots in every mode (FR-190).
- After a sandbox denial, escalation happens only through a policy `ask`; Nova never retries a
  command outside the sandbox on its own, and no allow rule removes the sandbox.
- The auto-reviewer runs after the deterministic policy engine and can only tighten its decision
  (ADR-061).
- `handoff_required` and `confirm_at_action` actions (FR-189) are never auto-approved in any
  mode, for example purchases, account creation, CAPTCHAs, credential changes and deletion
  outside the project or session scope.
- Every mode change is audited.

*As shipped in M5 (ADR-092).* The mode selector sits in the session's composer; a refused change
rolls back and says why. Unavailable modes stay listed, disabled, with the reason in their label:
Auto needs a reviewer model (`review.model`), and Bypass needs `code.allowBypass` and a
container or micro-VM substrate. A new session starts in the mode last used in its folder
(`code.folderModes`), else `code.permissionMode`, else Manual; a remembered mode that is not
available falls back to Manual, and Plan is never remembered. If an Auto or Bypass condition
lapses during a session, its turns run with Manual's axes and the gate records
`permissionMode: 'manual'`. In Plan mode the folder is a read-only root. The session's permission
mode is a per-thread policy source: the gate and the tools read the same approval policy, profile
and roots. Settings → Code holds the default mode, the reviewer model and **Allow Bypass mode**.
Managed policy can lock these settings; removing single modes by policy comes with managed
policy (M8).

## 4. Coding toolset

| Tool | Purpose |
| --- | --- |
| `fs.read` / `fs.list` / `fs.search` | Explore the repo |
| `fs.write` / `fs.edit` / `fs.delete` | Modify files (captured as diffs; `fs.edit` takes a structured patch) |
| `code.symbols` / `code.refs` | Symbol + reference lookup (tree-sitter index, FR-074) |
| `code.ast_query` | Structural search/rewrite (P1) |
| `exec.run` / `exec.write` / `exec.poll` | Interactive exec (FR-184): returns output after a yield time (default 10 s) or a session id for a still-running process; `exec.write` sends stdin, `exec.poll` reads new output. Output is redacted and capped (default 10,000 tokens). Sessions are listed in the terminal pane and killed when the run is cancelled |
| `git.*` | status/diff/branch/commit/log (P1) |
| `test.run` | Detect and run the project's test suite |
| `devserver.*` | Start/stop preview servers (FR-067) |
| `browser.*` | Preview and verify the app (FR-067) |
| `pr.create` / `pr.status` | Open/watch PRs (FR-070) |
| `review.run` | Structured code review (FR-069) |
| `appshot.capture` | Capture app state (FR-075, P2) |
| `task.spawn` / `task.wait` | Parallel worker in a separate worktree (FR-073; limits in `docs/09` §4) |
| `tool.search` | Find and load deferred MCP and plugin tools (FR-196) |
| `context.remaining` / `context.fresh` | Check context left or start a fresh context (FR-183) |

*As shipped in M5 (ADR-092).* A Code thread adds `git.status`, `git.diff`, `git.log`,
`code.symbols`, `code.refs` (read-only) and `test.run` (runs commands, so it passes the gate like
`exec.run`) to the built-ins; they are listed only in Code threads and refuse elsewhere. Branches
and commits are the user's action from the session header, not agent tools. `test.run` detects the
suite, runs it in the sandbox with network off, waits up to 10 minutes and then stops it; it
reports `code.test.completed`. `code.symbols` and `code.refs` use a pattern-based index, not
tree-sitter (§11). `ask_user` lets the agent ask the user a question (`docs/09` §9). Not in M5:
`code.ast_query`, `devserver.*`, `browser.*`, `pr.create`, `pr.status`, `review.run` (the review
is a button, §5), `appshot.capture`, and `task.spawn` with a worktree.

## 5. Diff & review flow (FR-064/065)

- Every mutation is recorded as a `code_change` with a unified patch blob.
- The **Diff pane** lists files with `+additions −deletions`, unified/split toggle, syntax
  highlighting, and word-level intra-line diffs.
- Clicking a line opens a comment box; comments are batched and submitted with `Cmd/Ctrl+Enter`;
  the agent receives them and produces a revised diff.
- Per-hunk accept/reject; "Accept all" and "Reject all". Accepted changes are written; rejected
  are reverted. The working tree is never left half-applied without a visible marker.
- `/review` (FR-069) produces a **Code review card** grouped by file with severity
  (info/warn/error), reasoning, and an "Apply fix" action; findings are also added as diff
  comments.
- Review runs automatically before commit when configured.

*As shipped in M5 (ADR-092).*

- **Change capture.** Each session keeps a shadow repository at `<dataDir>/code/<id>/shadow.git`,
  never inside the user's repository, with `refs/nova/baseline` (the accepted state) and
  `refs/nova/start` (the last committed state). It ignores system and global Git config and
  neutralizes filters and line-ending conversion; protected paths, credential locations and
  dependency caches are left out by pathspec, so an in-tree `.gitignore` negation cannot bring
  them back. There is one `code_change` row per path, holding its diff since the baseline.
  Changes refresh when the diff is opened, after each decision, at turn end and after every tool
  call of the session that is not read-only; that call's id is recorded on the change. Renames
  show as a delete and an add. Change and comment paths are relative to the session folder.
- **Decisions.** Hunks, files or everything can be accepted or rejected
  (`POST …/changes/:changeId/hunks`, 409 `stale_hunk` when the file moved on;
  `POST …/changes/accept|reject`); **Reject all** asks first. A rejected hunk is reverted in the
  working tree. Each file has a review round: decided hunks are kept until a fully decided file
  changes again. Partly accepted and binary files are marked.
- **Diff pane.** A file list, a unified or split layout, lines marked with + and − and spoken as
  "Added" and "Removed", and changed words highlighted inside a modified line. The diff reloads on
  `code.*` events and after every turn of the session.
- **Comments.** Clicking a line number opens a comment box. Comments collect as a batch and
  Ctrl/Cmd+Enter submits them to the agent as one message (`POST …/comments` with `submit: true`;
  409 when no agent can take them).
- **Review.** The **Review** button (or **Review changes** in the Review tab) starts a review
  (`POST …/review`, 202; `GET …/reviews/:reviewId`; `code.review.completed`). It covers all
  uncommitted session changes, accepted and pending, and uses the session's model, which must
  answer with a strict JSON list of findings; an invalid answer is retried once, then the review
  fails. The card groups findings by file with a severity icon and word (error, warning, note).
  Findings are stored as diff comments with author `review`, so they also show in the diff.
  **Apply fix** sends a comment at the finding's line when that file has a change, else a message
  quoting the fix. `/review` as a composer command, a review before every commit and
  `review_marker` thread items are not in M5.

## 6. Terminal (FR-066)

- xterm.js + node-pty bound to the session environment.
- Agent commands show a labeled chip ("agent") with the tool call id; user commands are plain.
  Running exec sessions (FR-184) are listed and can be killed.
- Output is streamed to the model as a truncated, redacted tool result.
- "Clear" (`Ctrl+L` / `Cmd+K`) and search; links are clickable; long output is virtualized.
- Dangerous commands are matched against the policy engine before execution.

*As shipped in M5 (ADR-092).* The session's Terminal tab opens shells through the workspace
terminals (ADR-091): `POST /code/sessions/:id/terminal {cols, rows}` starts one in the sandbox at
the session folder (409 `sandbox_unavailable` without a sandbox), streamed on
`/terminals/:id/ws`. Commands typed there are confined by the sandbox, not checked one by one.
The agent's exec sessions (FR-184) are listed with an "agent" chip, the tool call id and a
**Kill** button (`GET /exec/sessions?threadId=`, `DELETE /exec/sessions/:id`). A running
`test.run` is not listed there yet.

## 7. Browser pane & auto-verify (FR-067/068)

- A tabbed embedded browser (clean profile) opens `localhost` dev servers and external sites.
- `devserver` detects common frameworks (Vite, Next, CRA, Django, Rails, Go, custom via
  `.nova/launch.json`) and starts/stops them; a header menu can stop all.
- Auto-verify after edits (default on): the agent screenshots, inspects the DOM, clicks, and
  fills forms to confirm the change; failures feed back into the loop.
- External sites require per-site approval and are subject to a domain allowlist and safety
  classifier (FR-094/095). Purchases, account creation, and CAPTCHA bypass always require the
  user.
- A separate extension bridge can use the user's logged-in browser session with explicit
  consent (FR-096).

*As shipped in M6 (ADR-093).*

- **Dev servers (FR-097).** Detected from `.nova/launch.json`, package.json `dev`, `start`,
  `serve` or `preview` scripts (npm, pnpm or yarn), Django `manage.py`, Rails and Go. A server is
  an exec session in the session's sandbox with the folder writable, the network off and `PORT`,
  `HOST=127.0.0.1` and `BROWSER=none`; at most 4 run per session, a start that exits within 3 s is
  reported with its output, and servers live in Hub memory. The tools are `devserver.list`,
  `devserver.start` and `devserver.stop`. The sandbox keeps its own network namespace, so the
  port is published through the dev-server bridge (a Unix socket in the sandbox, a listener on the
  Hub's loopback): the URL is `http://127.0.0.1:<hostPort>/`, the bridge's port, while the view's
  `port` stays the server's own. The session thread's agent browser gets the egress proxy's
  loopback grant for exactly that host and port (`browser.devserver.granted`, `.revoked` when the
  server stops) and the browser pane (FR-067) opens it once it answers HTTP: within the start if it
  answers in 2 s, otherwise in the background for up to 2 minutes. The open is recorded in the
  browser's action trace as tool `devserver.open`. The container image needs `perl` for the
  bridge; without it the start fails with `dev_server_exited`. Dev servers run only for folders
  on the Hub (`capability_missing` `{reason: remote_environment}` otherwise).
- **Auto-verify (FR-068).** After a turn that edited files, on sessions on the Hub, the checks run
  in the sandbox with the network off: `code.autoVerify.commands`, else the detected typecheck or
  build script and the test command. Logs are redacted and capped at 8,000 characters. A failure
  goes back to the agent as a turn without the user's authority (trigger `event`), at most
  `feedbackTurns` times in a row. `POST …/verify` runs them on request. The agent does not drive the
  browser to verify; `code.autoVerify` is security-relevant, so a project cannot set the
  commands.

## 8. Git & PR flow (FR-070)

- The agent can create a branch named `nova/<slug>` (with a short id suffix when needed for
  uniqueness), commit with a clear message, and open a PR via a connected Git host (GitHub
  first; GitLab/Gitea P1).
- The session header shows the PR link and CI status (queued/running/passed/failed) with
  checks; clicking opens the checks or the review.
- CI failures feed back to the agent, which proposes fixes.
- **Hook-free app operations** (FR-211): Git operations Nova runs for its own bookkeeping
  (status, diff, worktree add/remove, fetch, branch listing) run with repository hooks
  disabled for that invocation only, for example with `core.hooksPath` pointed at an empty
  directory; the user's Git config is not changed. Commits and pushes the agent makes on the
  user's behalf run the repository's hooks only inside the session sandbox.
- Guards: never force-push protected branches; never push to a default branch without an
  explicit, typed confirmation; secrets are scanned before commit.

*As shipped in M5 (ADR-092).*

- **Hook-free Git.** Every Git call Nova makes for itself (status, diff, branch, update-index,
  worktree add and remove, its own commits) points `core.hooksPath` at an empty folder for that
  call only; a hooks path the user configured is overridden without changing their config.
- **Commit.** **Commit…** in the session header (`POST /code/sessions/:id/commit`) commits what the
  user accepted. On the default branch the dialog suggests `nova/<slug>` and refuses the default
  branch itself (403 `default_branch`); a taken name gets a short suffix. Nova switches to the new
  branch without a checkout, so no hooks run. The accepted content is staged into the user's index
  without touching the working tree, so pending hunks stay out unless **Accept the pending changes
  and include them** is ticked (it is by default); rejected changes are always left out. The commit
  is refused when the user has other staged changes (409 `staged_changes`), on a detached HEAD (409
  `detached_head`), when nothing is accepted (400 `nothing_accepted`), without a Git identity (400
  `no_identity`) and when added lines hold a secret (403 `secrets_found`, masked). Commit hooks run
  in the sandbox only when the repository has hooks and the sandbox image has Git, with the
  repository writable and network off; otherwise the Hub commits with hooks disabled and the dialog
  shows the Hub's note that they did not run (no note when the repository has no hooks). The result shows the sha and branch. The default branch comes from
  origin's HEAD, else `init.defaultBranch`, else `main` or `master` when that branch exists.
- **Not in M5.** Nothing is pushed. Opening a pull request, the PR link and CI status in the
  header, and CI failures feeding back to the agent (FR-070) come later.

*As shipped in M6 (ADR-093).*

- **Git hosts.** GitHub (and GitHub Enterprise by API URL) is connected with a personal access
  token kept in the keychain (`secret://code/githost/<id>/token`); a rejected token is never saved.
- **Push** (`POST …/push`, the `pr.create` tool). A connected host that matches the remote is
  asked for its default branch and the branch's protection first; a host error refuses the push.
  A protected or default branch needs `confirmBranch` typed exactly by the user (the agent's tools
  can never confirm) and is never force-pushed (`--force-with-lease` otherwise). The commits the
  remote lacks are scanned for secrets on the lines they add. The pre-push hook runs only in the
  session's sandbox. The token is passed only through that one Git call's environment, never
  written to config or a remote URL. A push with a connected host's token to an `http://` remote
  is refused before anything is sent (403 `policy_denied`, reason `insecure_remote`).
- **Pull requests and CI.** `POST …/pr` pushes and opens one (or returns the one already open);
  its link and CI status show on the session. Open pull requests are polled every
  `code.ciPollSeconds` (no webhook); a failure on an open pull request's head goes back to the
  agent once per pushed head when `code.ciFeedback` is on, without the user's authority. Check
  summaries from the host are untrusted.
- **Branches and commits by the agent.** `git.branch` creates `nova/<name>` without a checkout;
  `git.commit` commits only what the user accepted (no pending changes, no new branch) and is
  audited with actor `agent`. Inside a command sandbox `.git` is read-only, so `git commit` typed
  in a terminal or run with `exec` fails; commits go through these flows (`docs/12` §7.2).

## 9. Parallel agents & worktrees (FR-073)

- Independent tasks run in separate git worktrees (`<repo>/.nova/worktrees/<id>`, branch
  `nova/<slug>`), each with its own session and environment binding.
- The parent session can spawn workers via `task.spawn(role='coder', worktree=true)`.
- **Include file**: a `.worktreeinclude` file at the repo root lists git-ignored files (for
  example local env files) in gitignore syntax; files that are both ignored and matched are
  copied into each new worktree. Protected credential locations (FR-190) are never copied.
- **Registry and leases**: the Hub keeps a worktree registry (name, path, base repo, branch,
  source branch, created at, leased by). A worktree is leased to one session at a time; the
  lease is released when the session is archived or handed off.
- **Cap**: at most 15 worktrees per repo. At the cap, creating another offers to remove the
  oldest unleased, clean worktrees; leased or dirty worktrees are never removed silently.
- **Handoff**: a session can move between the main checkout and a worktree in either direction.
  Uncommitted changes travel as a patch; the move is refused when the target has uncommitted
  changes; it is recorded in the session history.
- **Merging**: the agent proposes an integration order; conflicts are surfaced in the Diff pane
  with a three-way view; the user or a merge agent resolves them.
- Worktrees are cleaned up on session archive (configurable).
- **Best-of-N** (FR-212, P2): a Code task can run N attempts (default 2, maximum 4) in separate
  worktrees. The user compares diffs and test results side by side and applies one; the other
  attempts are discarded on apply.

*As shipped in M5 (ADR-092).* **Work in a new Git worktree** on New session creates
`<repo>/.nova/worktrees/<8 hex>` on a new `nova/<slug>` branch from HEAD and leases it to the
session. A repository holds at most 15; at the cap creation fails with `worktree_cap`, naming the
unleased worktrees, and nothing is removed for the user. When the session's thread is archived
(checked when sessions are listed and every 5 minutes) a clean worktree is removed and a dirty one
is kept and released; `worktree.leased` and `worktree.released` are emitted. Not in M5: the
worktree registry routes, lease renewal and expiry, handoff, `.worktreeinclude`, a cleanup
setting, merging and best-of-N.

*As shipped in M6 (ADR-093).* The registry routes are `/api/v1/code/worktrees` (create, renew,
release, remove). A worktree created there can be leased to a session for a time (5 minutes to 7
days; the 5-minute sweep releases expired leases with reason `expired`) or wait unleased for a
session to bind it (`worktreeId` on New session). `.worktreeinclude` copies files that are both
git-ignored and matched, never protected or credential locations or symbolic links, at most 2,000
files and 200 MiB. At the cap of 15, `removeOldest: true` removes the oldest unleased clean
worktree first; nothing is removed otherwise. A release is refused while a session works in the
worktree; removing one is refused while it is leased and needs `force` when it is dirty.
`code.worktreeCleanup` (`remove_clean` or `keep`) decides what an archived session does with its
clean worktree; dirty ones are always kept. `task.spawn` starts a worker as its own Code session
in a new worktree from the parent's HEAD, with the parent's environment, model and mode (Manual
when that mode cannot be used), at most 4 at once; `task.wait` waits for them. Both are listed
only in Code threads and count as read-only; each worker's actions pass the gate. Not in M6:
session handoff, three-way merging and best-of-N.

## 10. Cross-session operations (FR-072)

- `sessions.list`, `sessions.message`, `sessions.archive` tools let an agent coordinate with
  sibling sessions, with the user's permission.
- Side questions (`Cmd/Ctrl+Alt+S`) answer using session context without adding turns to the
  main thread.

*As shipped in M6 (ADR-093).* `sessions.list`, `sessions.message`, `sessions.archive` and
`sessions.ask` are offered in Code threads (agent threads get their own `sessions.*`, `docs/09`
§8). `sessions.message` starts a turn in the other session without the user's authority and,
with `sessions.archive`, is a write the gate asks about by default. A side question
(`POST …/ask`) is one model call without tools over the session's facts and its newest 60
messages (≤ 24,000 characters, as data), at most 2,048 output tokens and 120 s; nothing is added to
the thread. Code sessions also get budgets (time, tokens, cost; `docs/09` §2) from `code.budgets`
or the session, checked before each model step and extended with `POST …/budget/extend`.

## 11. Context engineering for code

- **Repo map**: a compact, ranked outline of the repository (files, key symbols) maintained by
  the indexer and injected within a token budget.
- **File reads** are on-demand and cached; large files are chunked with line-aware summaries.
- **@-mentions** add files/folders/symbols; the composer shows mention chips.
- **Instruction files** (FR-185, full rules in `docs/09` §11): from the project root (nearest
  `.git` or a configured marker) down to the working directory, each directory contributes at
  most one of `.nova/instructions.md`, `AGENTS.md` or a configured fallback name. All files
  share a 32 KiB budget; overflow is truncated with a warning. Untrusted projects are skipped:
  a folder is trusted once the user confirms it on first open, or when managed policy lists it.
  Project config cannot change the root markers or the budget. Conflicts between files are
  surfaced.
- **Network**: denied by default; enabling is per-session and visible.

*As shipped in M5 (ADR-092).* The symbol index is a pattern-based extractor kept in memory per
session (up to 16 sessions, files up to 512 KiB, 20,000 files), refreshed lazily when files
change; references are a whole-word search. **Go to symbol** in the session header is a
combobox over `GET …/symbols?q=`; choosing a symbol opens the file in the editor at its line.
`GET …/refs?name=` lists references. Symbol and ref paths are relative to the repository root.
Instruction files are discovered from the session folder (`docs/09` §11); there is no
project-trust step yet, so a folder the user added counts as trusted. The repo map, semantic
search and mention chips for symbols are not in M5.

## 12. Cloud sessions (FR-071)

- Created from a repo + setup script + base image; produce a working copy with dependencies
  installed.
- Support multiple repositories mounted side by side.
- Persist across app restarts; snapshots are taken before risky operations.
- Console/log access is available; costs are shown per session when the provider meters.
- Self-hosting the cloud runner is P2 (same `Computer` interface over gRPC).

## 13. Mobile dispatch (FR-077, P2)

- Every client drives sessions through the Hub, so a phone can start a task, steer it, or
  answer an approval via the Relay (`docs/13` §5).
- The phone shows run status and diffs; approvals offer the same decisions as on desktop
  (FR-100), except tiers that must be answered on an authenticated client.
- Deep links (`nova://code/<id>`) open the desktop app to the exact session.

## 14. Failure & recovery

| Failure | Recovery |
| --- | --- |
| Build/test failure | Surface logs; agent proposes fix; optional automatic retry once |
| Sandbox/VM crash | Checkpoint worktree; offer to recreate environment and reapply diff |
| Merge conflict | Three-way view; optional merge sub-agent; never auto-resolve silently |
| Lost connection to cloud/SSH | Buffer output; reconnect; resume from last committed step |
| SSH helper missing or outdated | Reinstall or upgrade the `novad` helper after signature check; refuse to run with an unverified helper |
| Model context overflow | Compact history + repo map (FR-183); continue |
| Concurrent edit conflict (user + agent) | Detect mtime/hash change; ask before overwrite |
| Handoff target dirty or unreachable | Refuse the handoff; the session stays where it was |

## 15. Session handoff & CLI (FR-213)

- **Handoff**: a Code session or chat can move to another device or environment with its Git
  state: branch, HEAD, local commits not on a remote (sent as a Git bundle through the Hub),
  uncommitted changes as a binary-safe patch, and the worktree identity. The target checks out
  the branch, applies the patch and confirms that its HEAD and diff hash match the source's;
  only then does the session continue there. The source working tree is left untouched until
  that confirmation, and the user chooses whether to clean it.
- Execution location changes only between turns (FR-127): a handoff waits for the current turn
  to end, or interrupts it on request.
- The move is recorded in the session history (from, to, Git state hash).
- **CLI** (P2): a `nova` CLI client attaches to Hub sessions over the Hub API with a scoped
  token. It can start headless sessions with machine-readable output for scripts, and hand a
  terminal session to the desktop or web UI and back. The CLI is a client only; the Hub runs
  the loop (ADR-076).
