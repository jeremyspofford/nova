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

## 6. Terminal (FR-066)

- xterm.js + node-pty bound to the session environment.
- Agent commands show a labeled chip ("agent") with the tool call id; user commands are plain.
  Running exec sessions (FR-184) are listed and can be killed.
- Output is streamed to the model as a truncated, redacted tool result.
- "Clear" (`Ctrl+L` / `Cmd+K`) and search; links are clickable; long output is virtualized.
- Dangerous commands are matched against the policy engine before execution.

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

## 10. Cross-session operations (FR-072)

- `sessions.list`, `sessions.message`, `sessions.archive` tools let an agent coordinate with
  sibling sessions, with the user's permission.
- Side questions (`Cmd/Ctrl+Alt+S`) answer using session context without adding turns to the
  main thread.

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
