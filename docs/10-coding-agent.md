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
  user or auth method needs a new credential. The M6 Hub bound no SSH transport, so SSH
  environments checked `down` and answered `capability_missing` `{reason: no_ssh_transport}`; M7
  adds the transport (below).
- **wsl**: a distro on a Windows device. The device connection has no WSL operations yet, so every
  device answers `not_windows`.
- **device**: a machine running `novad` (`docs/23`); the session reaches its files and processes
  only through `novad` under the session's own grants. `verified` means the device is active and
  needs no update, until signed builds arrive.

Commands of SSH, WSL and device sessions run on that machine under its user, not in a container
(their sandbox reports no substrate). `novad` owns their processes and buffers the newest 1 MiB of
output, so a dropped connection is reattached from the stored offset
(`/environments/:id/processes/:processId/output?offset=`). In M6 these sessions had no Hub-side
change capture: changes listed empty and review, commit, branch, push, symbols, refs and the
`git.*` tools answered `capability_missing` `{reason: remote_environment}` (M7 adds capture,
review, commits, branches and the read-only `git.*` tools, below); auto-verify runs only on request
there. Mode checks read the sandbox the session's commands run in: Bypass is never available on
another machine (SSH, WSL, device); a container environment uses its own sandbox, a local one the
Hub's. Container environments' sandboxes reach the network only through the egress proxy (none
without it); `NOVA_SANDBOX_NETWORK=open` does not apply to them. VM environments are not offered;
cloud environments came in M7 (§12).

*As shipped in M7 (ADR-095).*

- **SSH (FR-062).** Off by default: the security setting `code.ssh.enabled` (Settings → Code asks
  before turning it on) must be on, else a connection answers `capability_missing`
  `{reason: ssh_disabled}`. The Hub runs the system's OpenSSH client (`no_ssh_client` without one)
  and never uses the user's own SSH config, agent or known hosts (`-F /dev/null`,
  `IdentitiesOnly`, no forwarding). For each connection the credential is read from the vault and
  written only into a new 0700 folder under `<dataDir>/code/ssh`: a key as a 0600 file, a password
  or passphrase through `SSH_ASKPASS` for that one client process. The folder is removed when the
  connection closes, and folders a crashed Hub left behind are removed when the transport starts.
  Calls share one connection (kept 120 s after the last use); connecting times out after 15 s.
- **Host keys.** The first connection accepts the key the host presents and pins it in the
  environment (audited as `environment.hostkey.pinned`, announced as `environment.updated`
  `{change: hostkey_pinned}`); after that only that key is accepted. A different key is refused
  before anything is sent (`policy_denied` `{reason: host_key_mismatch}`) and audited as
  `environment.hostkey.mismatch`. When two first connections race, the second one's key must
  match the one the first pinned. A pinned key cannot be changed or cleared through
  `PATCH /api/v1/environments/:id` (409 `repin_required`);
  `POST /api/v1/environments/:id/hostkey/reset` (**Forget the pinned key…** on the environment)
  forgets it on purpose, audited as `environment.hostkey.reset` and announced with
  `change: hostkey_reset`, and the next connection pins anew. Changing the host or port drops the
  pin, audited the same way.
- **The helper.** `novad` has no helper mode yet, so the SSH helper is a small POSIX shell program,
  and no socket is forwarded. The Hub uploads it to `~/.nova/remote/helper.sh` (folders 0700),
  checks its SHA-256 on the host before every connection starts, replaces it when it differs, and
  runs it by the absolute path it checked. A helper that fails the check never runs: the
  environment checks `down`, and commands, Hub-side Git and file operations answer
  `capability_missing` `{reason: helper_unverified}`. The helper starts each command detached in
  its own process group with its output in a file, so it keeps running while the Hub is away; the
  folders of commands that finished more than a day ago are removed.
- **Argument safety.** A host or user that starts with `-` is refused by the schema and again by
  the transport, every ssh call puts `--` before the host, option values are quoted, and a run
  folder containing `"`, `%` or a newline is refused. Tests drive the real transport and helper
  through a stand-in ssh client; nothing has run against a real SSH server yet, so connection
  reuse is untested.
- **Remote sessions.** Sessions on another machine (SSH, WSL, device, cloud) now get Hub-side
  change capture, the Diff pane, review, commits, branches and the read-only `git.*` tools. Their
  Git runs through the environment's transport (one helper process per call over SSH and on
  devices, the runner for cloud) with hooks off, and their shadow repository lives in Nova's state
  folder on that machine (`~/.nova/remote/state`), never in the repository. A session takes its
  baseline before its first tool call. Remote file writes check each parent folder in turn and
  never follow a symbolic link, not even to create a folder behind it; a removal deletes a link,
  never its target. Symbols, refs, dev servers, worktrees, workers (`task.spawn`), best-of-N,
  merging another session's work and pushes stay Hub-only (`capability_missing`
  `{reason: remote_environment}`); auto-verify still runs only on request there, with the
  `code.autoVerify.commands`. WSL environments still answer `not_windows`, so in practice this
  covers SSH, device and cloud sessions.
- **File tools on the other machine.** In SSH, WSL and device sessions `fs.read`, `fs.list`,
  `fs.write`, `fs.edit` and `fs.delete` act on the session folder on that machine, through the
  same helper (or device provider) as its Git, never on the Hub's disk at the same path. They keep
  the Hub's path rules: nothing outside the folder (a target's parent folder, resolved there, must
  stay inside it), credential files never, protected paths (`.git`, `.nova`, `.agents`, …) read-only,
  and symbolic links never followed (reading or writing through one is `path_denied`; deleting
  removes the link). `exec.run`'s `cwd` resolves in that folder too. `fs.search`,
  `document.read` and `document.create` only work on the Hub's disk, so they are hidden there (a
  deny rule). The thread has no folder on the Hub at all: the gate's only root is the folder on
  that machine, so a path outside it is refused and a path inside it names a file there, and the
  tool scope (mentions, instruction files, the file browser, hooks' working folder) has no root on
  the Hub. When the machine cannot be reached, the file tools fail
  with `remote_unavailable` and commands with `sandbox_unavailable`; nothing falls back to the
  Hub. Terminals open on the Hub's disk, so they are refused (`capability_missing`
  `{reason: remote_environment}`) for every session on another machine, cloud included. Cloud
  threads still hide all `fs.*` tools (§12) and change files with commands.

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
`test.run` is not listed there yet. Since M7 a session on another machine (SSH, WSL, device,
cloud) opens no terminal (`capability_missing` `{reason: remote_environment}`): terminals run on
the Hub's disk, and the session's path names a folder elsewhere (§2).

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
only in Code threads and count as read-only; each worker's actions pass the gate. Session handoff,
three-way merging and best-of-N came in M7 (below).

*As shipped in M7 (ADR-095).*

- **Handoff between the main checkout and a worktree (FR-213).** A session with a folder on the
  Hub can move to a new worktree, to an unleased registry worktree of the same repository, or back
  to the main checkout, with its Git state (§15). The worktree it leaves is released with
  `worktree.released` `{reason: handoff}`.
- **Three-way merges (FR-073).** `POST …/merge` (201) merges work onto the session's folder, either
  another session's (`{from: {sessionId}}`: a worker or an attempt, both folders on the Hub, in the
  same repository and the same folder of it; otherwise 400 `same_session`, `other_repository` or
  `other_folder`, and `capability_missing` `remote_environment`) or a patch (`{from: {patch, base?}}`:
  `git diff --binary --full-index` output up to 16 MiB, made against `base`, by default HEAD; the
  session may be on any machine; `missing_base`, `patch_mismatch`). For a session the base is the
  merge base of the two HEADs, and "theirs" is the other session's working state, uncommitted
  changes included. Each changed file is merged from the base, ours (the folder now, uncommitted
  edits included) and theirs: a side that did not change takes the other, and when both changed
  `git merge-file --diff3` merges the text on the Hub. Binary files and symbolic links always
  conflict as a whole (`binary_conflict`), and so does a deletion against a change. With
  `onConflict: 'refuse'` (the default) nothing is written when any file conflicts: the answer is
  409 `merge_conflict` with the paths, and the merge is kept as `refused` with each conflicting
  file's three sides (redacted, at most 24,000 characters a side and 50 files) for the **Merges**
  tab. With `'markers'` the merged files are written with diff3 conflict markers (binary conflicts
  are left for the user) and the merge stays `conflicted`: `POST …/merges/:mergeId/resolve` answers
  409 `merge_conflicts` while a marker is left, and so does every commit; once no marker is left,
  the next commit counts the merge as resolved. `POST …/merges/:mergeId/abort` puts the files a
  conflicted or applied merge wrote back from the copy it kept under the data folder. A merge
  handles at most 256 MiB. Audited as `code.merge`, `code.merge.resolved` and `code.merge.aborted`;
  announced as `code.merge.completed`. Merging is the user's action: the agent proposes no
  integration order, and there is no merge sub-agent.
- **Best-of-N (FR-212).** **Best of N…** in the session header (`POST …/attempts`, 201) runs one
  objective as 2 to 4 attempts (default `code.attempts.count`, 2). Each attempt is a Code session
  of its own in a new worktree on a `nova/<slug>` branch from the session's last commit (the
  session's uncommitted changes are not there), with the session's environment, mode (Manual when
  an attempt cannot use it) and model, or the model the request names for that attempt. Each gets
  the request's budgets or `code.attempts.budgets` (default 30 minutes, no token or cost limit),
  never more than the parent session has left. The attempts start at once, with the user's
  authority when the user started them, and are told not to commit. When an attempt's turn ends
  its checks run in its worktree, only while `code.autoVerify` is on (the auto-verify run if one
  started, else one run); with auto-verify off, attempts run no checks. The comparison
  (`GET /api/v1/code/attempts/:setId`, the **Attempts** tab) shows for each attempt the files it
  changed against the base (kind, + and − counts, binary), its redacted patch (commits and
  uncommitted work together, at most 256 KiB), its newest check run, its budget use (time, tokens,
  cost) and its last reply (untrusted, at most 4,000 characters).
  `POST /api/v1/code/attempts/:setId/apply {attemptId, onConflict?}` stops the attempts still
  running and merges the chosen one three-way onto the session's folder (above). A refused merge
  changes nothing and keeps the attempts; otherwise every attempt session is archived, its
  worktree removed and its branch deleted when it has no commits. `…/discard` stops, archives and
  removes them all. Attempts need a folder on the Hub with a commit (`remote_environment`,
  `no_commits`).
  Audited as `code.attempts.started`, `code.attempt.applied` and `code.attempts.discarded`;
  announced as `code.attempts.updated`.
- **Worker budgets.** A `task.spawn` worker, like an attempt, gets at most what its parent session
  has left of each budget; a bound the parent does not have takes the default.

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

*As shipped in M7 (ADR-095).*

- **Delegation from an agent.** Agent threads get `code.delegate`
  `{projectId, objective, folder?, title?, mode?}`. It starts a Code session on this Hub in one of
  the account's projects, in the project's first folder or a folder inside one of its folders
  (`outside_project` otherwise, `no_project_folder` when it has none), and returns at once. The
  session runs in Manual mode, or Plan to only read, never broader, and the mode is not remembered
  for the folder. It takes the agent's budgets (`code.budgets` when the agent has none) and has no
  user authority: its first message is the agent's text. The agent's rules apply in the session
  and in every worker and attempt it starts (found through the session's parent chain), and so do
  the agent's plugin limits (FR-045). When the session's turn ends, its last reply (at most 4,000
  characters, as data) goes to the agent's main thread as a turn without the user's authority.
  Delegation is refused from proactive threads (`proactive_read_only`) and from threads shared with
  other people (`shared_thread`). Pausing or stopping the agent cancels the running turns of the
  sessions it started, and the gate denies their actions until it resumes; deleting the agent
  cancels them, archives those sessions and their workers and marks running delegations failed
  (audited as `code.delegation.held` and `code.delegation.cancelled`). A delegation whose agent's
  rules are gone is denied everything. Audited as `code.delegate` with actor `agent:<id>`;
  announced as `code.delegation.started` and `code.delegation.completed`.
- **External agents (FR-203).** While the security setting `externalAgents.enabled` is on (off by
  default), the user can delegate from a Code session to an external coding agent
  (`POST /api/v1/code/sessions/:id/delegations`, the session's **Agents** tab); a model tool never
  starts one. The agent runs in the session's sandbox with the folder read-only and no network, or
  only the hosts its adapter declares. Every file read, write and command it asks for runs as an
  `fs.*` or `exec.*` call through the gate, so its edits show as the session's diffs. It is refused
  in SSH, WSL and device sessions, whose commands have no sandbox (`no_substrate`), and cannot
  have network in a cloud session (`no_egress_proxy`). Adapters, permission routing, limits and
  events are in `docs/08` §1.6.

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

*As shipped in M7 (ADR-095).* A `cloud` environment runs on the cloud runner (`services/runner`;
the runner, its sandbox and its API are in `docs/13` §3 and `contracts/rest-api.md` §5). The Hub
keeps the agent loop, the model calls and the policy gate; the runner holds the environment, runs
its commands and file operations, streams their output and keeps snapshots (FR-108). Commands keep
running there while the user's client is offline (FR-071), and output is read by offset, so
reattaching shows what was missed.

- **Runner.** Settings → Cloud registers one runner per Hub: its URL (`cloud.runner.url`: https,
  or http only to this machine) and its token, which goes to the vault
  (`secret://cloud/runner/token`). `cloud.runner.enabled` is off by default. Without a working
  runner, cloud commands are refused (`no_cloud_runner`, `runner_unconfigured`, `runner_disabled`)
  and never run on the Hub.
- **Environments** (kind `cloud`, created through `POST /api/v1/environments`). The connection
  holds `repoUrls` (at most 10, cloned side by side under `/workspace`: `https://` with an optional
  `#branch`, or `file://` only from folders the runner allows; a URL with a user name or password
  is refused, `credentials_in_url`), `setupScript` (run once, at most 20,000 characters),
  `baseImage`, `caches` (at most 8 named caches kept between runs), `network` (`off` by default,
  `setup` for the setup script only, or `on`), `diskMb` (at most, and by default, the disk cap) and
  `folder` (where sessions and runs work: under `/workspace`, by default the first repository).
  `setup` and `on` are refused (`cloud_network_off`) unless the security setting
  `cloud.runner.unrestrictedNetwork` is on, because the runner's network does not go through the
  Hub's egress proxy: no allowlist, no blocking of private addresses, no egress audit. Even then a
  command gets network only when the turn's own network mode is not off and the environment allows
  it. Rebuilds are explicit (`POST /api/v1/cloud/environments/:id/rebuild`).
- **Code sessions** in a cloud environment work in a folder under `/workspace`
  (`outside_workspace` otherwise), and their commands run on the runner. The Hub's `fs.*` tools
  are hidden in cloud threads (a deny rule, so the tool runtime leaves them out); files are read
  and changed with commands there. Change capture, the Diff pane, review and commits run their Git
  through the runner (§2). Bypass is not offered: the commands run on another machine. Terminals
  are refused (`capability_missing` `{reason: remote_environment}`): they would open on the Hub's
  disk at the session's path. Under its
  budget the session shows its cloud run's usage against the caps, live, with **Raise caps** and
  **Cancel**.
- **Work runs** on a cloud environment (`POST /api/v1/cloud/work`): the environment must be ready,
  a snapshot is taken first unless `snapshot: false`, the run's commands go to the runner and its
  folder there is its only write root. A folder the runner reports outside `/workspace` is refused
  (`runner_path`). Snapshots are otherwise taken and restored on request.
- **Leases and caps (FR-116).** Each thread holds one lease (a runner run) with CPU and wall-time
  caps from `cloud.runner.caps`: 3,600 s of CPU and 14,400 s of wall time per run, 10,240 MB of
  disk per environment, and a warning at 80 % of a cap. The Hub's own Git and file calls use a
  separate lease per environment. Wall time counts only while a command runs. At a cap the
  commands stop, and new ones answer `budget_exhausted` `{reason: cap_reached}` until the caps are
  raised (`PATCH /api/v1/cloud/runs/:id`). A lease ends when its session is archived or its Work
  run ends.
- **Not built.** Egress through the Hub's proxy (so cloud network stays off unless the owner turns
  on unrestricted network), encrypted snapshots (they are plain files on the runner), agent
  computers on this runner (they stay on the mock cloud runner), and costs per session. The runner
  speaks HTTP (`contracts/rest-api.md` §5), not the `Computer` interface over gRPC.

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

*As shipped in M7 (ADR-095).* A merge conflict is never resolved silently: by default the merge
writes nothing and keeps the three sides to show; with markers, commits wait until no marker is
left (§9). There is no merge sub-agent. An SSH helper whose SHA-256 differs is replaced before it
starts, and one that still fails the check never runs (§2). A handoff whose target is dirty,
unreachable or fails any check is refused with its reason, the target is put back as it was and
the session stays where it was (§15). A cloud command that dropped its connection keeps running on
the runner and is read on from its offset (§12).

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

*As shipped in M7 (ADR-095).*

- **Targets.** **Hand off…** in the session header (`POST /api/v1/code/sessions/:id/handoff`, 202)
  moves a session to another saved environment and the repository folder there
  (`{to: {environmentId, folder}}`, the folder as its full path: this Hub, an SSH host, a device or
  a cloud environment) or, for a session with a folder on the Hub, to a worktree of the same
  repository (`{to: {worktree}}`: `'new'` creates one on a `nova/<slug>` branch from the session's
  HEAD and the session continues on that branch, an id binds an unleased registry worktree, and
  `'main'` goes back to the main checkout, which takes over the session's branch). A request that
  names the place the session already is (409 `same_location`), an archived session, an unknown
  environment, or a second handoff while one runs (409 `handoff_running`) is answered at once and
  not recorded. Worktree targets need a folder on the Hub (`worktree_unavailable`) and the same
  repository (`worktree_repo`).
- **What travels.** The branch and HEAD; the local commits no remote has, as a Git bundle through
  the Hub; every uncommitted change, tracked or new, text or binary, as one binary-safe patch
  (`--binary --full-index`) made in a short-lived shadow that borrows the repository's objects, so
  no filter, hook or attribute of the repository runs; and the worktree identity. The record shows
  the patch's SHA-256 and size, the number of files, the bundle's SHA-256 and commit count, and the
  state hash: SHA-256 over HEAD and the tree of the whole working state, which the target must
  confirm. The patch may be up to 256 MiB and the bundle up to 512 MiB (`too_large`).
- **The target's checks.** The named folder must pass the environment's folder check and be in a
  Git repository there. The session lands in the same subfolder of that repository as at the
  source, and that folder must stay inside the repository and pass the same checks as a new
  session's folder (the Hub's folder rules on the Hub, the path rules elsewhere; for a worktree,
  its main checkout's folder). The target repository must have no uncommitted changes (Nova's own
  `.nova/` worktrees aside) and have the session's commits, from the bundle or already, and its
  copy of the branch must have no commits the session lacks; the branch is then moved forward to
  the session's HEAD and checked out. The patch is applied, and the target must show the same HEAD
  and working-state tree. Only then does the session move: its environment, folder, worktree and
  branch change, and its review restarts at the target with every traveled change pending
  (earlier change rows are hidden, their comments kept). A mode the target cannot offer (Bypass
  on another machine) becomes Manual, audited as `code.mode.changed`.
- **Refusals.** A failed check puts the target back as it was, and the session stays where it
  was. The handoff is recorded as `refused` or `failed` with a reason (`HandoffReason`):
  `turn_running` (still running after the wait), `same_location`, `not_a_repository`,
  `no_commits`, `detached_head`, `target_dirty`, `target_missing` (the named folder fails its
  check, the target repository cannot be read, or the worktree cap is reached),
  `target_unreachable`, `protected_folder` (the landing folder is outside the repository or fails
  the folder rules), `other_repository`, `missing_commits`, `branch_diverged`, `branch_in_use`
  (the target cannot check out the branch), `conflicts` (the patch does not apply),
  `verify_failed` (HEAD or tree differ), `too_large`, `remote_state_unavailable` (Nova has no
  state folder on that machine), `environment_unavailable` and `failed` (anything else, such as a
  branch name that looks like an option). `same_location` comes back as a request error.
  `detached_head`: the session is not on a branch (commits made at the target would belong to no
  branch), so create one first. `other_repository`: the target folder's repository has commits but
  none of the session HEAD's root commits; an empty repository and a shallow clone are not judged
  by this check (the commit checks still apply).
- **The source.** Until the target confirms, the source working tree is untouched. Then it is kept
  or cleaned as the request's `source` says, else as `code.handoffSource` (Settings → Code; `keep`
  by default). When uncommitted changes traveled, `clean` puts those files back to HEAD and removes
  the worktree the session left, if it came from one.
- **Turns (FR-127).** A handoff waits up to 30 minutes for the session's running turn to end, or
  interrupts it with `interrupt: true`, and holds the session's next turns until it is done: a turn
  that starts meanwhile runs where the session lands.
- **Files and history.** The patch and the bundle are kept under `<dataDir>/code/handoffs/<id>`
  (mode 0600). The bundle is deleted when the handoff completes; the code area's 5-minute sweep
  removes the rest once the handoff is 7 days old. Every move is a `session_handoff` row
  (`GET …/handoffs`, newest first, and the session's **Moves** tab; `GET /api/v1/handoffs/:id`),
  announced as `session.handedOff`
  `{handoffId, threadId, sessionId?, from, to, branch?, status, reason?}` when it is pending,
  running and settled, and audited as `code.handoff.requested`, `code.handoff.completed`,
  `code.handoff.refused` or `code.handoff.failed`.
- **Chats.** `POST /api/v1/threads/:id/handoff {to: {deviceId}, interrupt?}` moves a chat (not a
  Code thread: `code_thread`) to one of the account's devices that is not revoked. The move is
  recorded as completed at once, announced so that device's client can open the chat, and audited
  as `thread.handoff`; `interrupt` cancels a running turn. The chat's turns still run on the Hub,
  so the move changes where it is shown, not where it runs. The web app has no control for it yet.
- **Not built.** The `nova` CLI.
