# 10 — Coding Agent (Code Mode)

Code mode is an agentic software-engineering surface built on the same runtime as Work, with
a coding toolset and an environment binding. It covers repo-aware editing, diff review,
terminal execution, browser verification, and cloud/local/remote environments.

## 1. Session model (FR-061)

A **code session** is a `thread(mode='code')` plus a `code_session` row binding:

- **Environment**: `local` | `cloud` | `ssh` | `wsl` | `container` (FR-062).
- **Project folder / repo** (one or more for cloud).
- **Permission mode** (FR-063): `manual`, `accept_edits`, `plan`, `auto`, `bypass`.
- **Model + reasoning level**.
- **Git worktree/branch** (isolated per session when parallel).
- **Panes layout** (chat/diff/browser/terminal/editor), persisted per session.

Sessions run in parallel and are independently listed in the sidebar with status, unread
indicators, and "needs attention" ordering (`Ctrl/Cmd+Alt+A`).

## 2. Environments

```ts
interface Environment {
  id: string; kind: 'local'|'cloud'|'ssh'|'wsl'|'container';
  label: string;
  connection: LocalConfig | SshConfig | WslConfig | CloudConfig | ContainerConfig;
  health: { status: 'ok'|'degraded'|'down'|'unknown'; checkedAt: string; detail?: string };
}
```

- **Local**: sandboxed host execution within the project root.
- **Cloud**: remote workspace created from a repo + setup script; persists between runs;
  continues when the laptop is offline (FR-071).
- **SSH**: remote host over SSH; agent runs remotely; reattach shows buffered output (FR-078).
- **WSL**: runs inside a chosen WSL distro.
- **Container**: rootless podman container from a recipe.

Each environment is created once and reusable. Cloud environments pin a machine image and
setup script; rebuilds are explicit.

## 3. Permission modes (FR-063)

| Mode | Behavior | Notes |
| --- | --- | --- |
| **Manual** | Ask before every edit and command; show diff first | Default for new local sessions |
| **Accept edits** | Auto-accept file edits + safe FS commands; still ask for other commands | Faster iteration |
| **Plan** | Read/explore only; propose a plan; no source edits | Per-session only |
| **Auto** | Run without routine prompts; a background classifier vets shell/network actions | Requires capable model; can be disabled by policy |
| **Bypass** | No prompts except non-auto-approvable actions | Only in sandbox/containers; gated by settings/policy |

Rules:

- Switchable mid-session via the composer's mode selector.
- Remembered per folder (except Plan).
- Managed policy can disable modes (FR-106).
- Some actions are never auto-approved in any mode: purchasing, account creation, CAPTCHA,
  credential changes, and irreversible destructive operations outside the project.
- Every mode change is audited.

## 4. Coding toolset

| Tool | Purpose |
| --- | --- |
| `fs.read` / `fs.list` / `fs.search` | Explore the repo |
| `fs.write` / `fs.edit` / `fs.delete` | Modify files (captured as diffs) |
| `code.symbols` / `code.refs` | Symbol + reference lookup (tree-sitter index, FR-074) |
| `code.ast_query` | Structural search/rewrite (P1) |
| `exec.run` | Run build/test/lint (streamed) |
| `git.*` | status/diff/branch/commit/log (P1) |
| `test.run` | Detect and run the project's test suite |
| `devserver.*` | Start/stop preview servers (FR-067) |
| `browser.*` | Preview and verify the app (FR-067) |
| `pr.create` / `pr.status` | Open/watch PRs (FR-070) |
| `review.run` | Structured code review (FR-069) |
| `appshot.capture` | Capture app state (FR-075, P2) |
| `task.spawn` | Parallel worker in a separate worktree (FR-073) |

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

- The agent can create a branch named `nova/<slug>-<shortid>`, commit with a clear message,
  and open a PR via a connected Git host (GitHub first; GitLab/Gitea P1).
- The session header shows the PR link and CI status (queued/running/passed/failed) with
  checks; clicking opens the checks or the review.
- CI failures feed back to the agent, which proposes fixes.
- Guards: never force-push protected branches; never push to a default branch without an
  explicit, typed confirmation; secrets are scanned before commit.

## 9. Parallel agents & worktrees (FR-073)

- Independent tasks run in separate git worktrees (`<repo>/.nova/worktrees/<id>`), each with
  its own session and environment binding.
- The parent session can spawn workers via `task.spawn(role='coder', worktree=true)`.
- Merging: the agent proposes an integration order; conflicts are surfaced in the Diff pane
  with a three-way view; the user or a merge agent resolves them.
- Worktrees are cleaned up on session archive (configurable).

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
- **Rules files**: the agent reads `AGENTS.md`, any project instruction file, and
  `.nova/instructions.md` if present, and surfaces conflicts.
- **Network**: denied by default; enabling is per-session and visible.

## 12. Cloud sessions (FR-071)

- Created from a repo + setup script + base image; produce a working copy with dependencies
  installed.
- Support multiple repositories mounted side by side.
- Persist across app restarts; snapshots are taken before risky operations.
- Console/log access is available; costs are shown per session when the provider meters.
- Self-hosting the cloud runner is P2 (same `Computer` interface over gRPC).

## 13. Mobile dispatch (FR-077, P2)

- A lightweight relay allows starting a task or approving an action from a phone.
- The phone shows run status and diffs; approvals support the same four decisions.
- Deep links (`nova://code/<id>`) open the desktop app to the exact session.

## 14. Failure & recovery

| Failure | Recovery |
| --- | --- |
| Build/test failure | Surface logs; agent proposes fix; optional automatic retry once |
| Sandbox/VM crash | Checkpoint worktree; offer to recreate environment and reapply diff |
| Merge conflict | Three-way view; optional merge sub-agent; never auto-resolve silently |
| Lost connection to cloud/SSH | Buffer output; reconnect; resume from last committed step |
| Model context overflow | Compact history + repo map; continue |
| Concurrent edit conflict (user + agent) | Detect mtime/hash change; ask before overwrite |
