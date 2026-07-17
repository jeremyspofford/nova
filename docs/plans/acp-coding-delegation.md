# ACP coding delegation — Nova drives coding agents, not a bespoke harness

Implementation plan (authored 2026-07-17 with Fable). Origin: Jeremy wants
coding capabilities "probably soon". The roadmap's Later item assumed
building a coding harness (repo tools, shell, test runner, sandboxing).
The **Agent Client Protocol (ACP)** changes the math: Nova becomes an ACP
*client* that drives an existing coding agent — Claude Code, Gemini CLI,
and others speak it — so this is an integration project, not an
agent-building project. This plan supersedes the harness assumption; the
Later item now points here.

HONEST CAVEAT UP FRONT: ACP is young and moving fast, and this spec's
protocol knowledge dates to early 2026. **Phase 0 is a validation spike
whose findings may reshape every later phase.** Treat phases 1–3 as the
intended shape, not gospel.

## Protocol essentials (validate in phase 0)

- JSON-RPC over stdio between a client (editor/orchestrator — here, Nova)
  and an agent subprocess. Spec: agentclientprotocol.com.
- Session-based: initialize → create session (cwd = the workspace) →
  prompt turns; the agent streams updates (plans, tool-call reports, text)
  as it works.
- **The client owns permissions**: the agent ASKS the client before tool
  use (`session/request_permission`-class calls); the client can also
  provide the filesystem (agent reads/writes THROUGH client-side methods).
  If FS mediation holds up in the spike, Nova's broker can enforce
  worktree confinement at the protocol level, not just the container
  level — confirm this, it's the strongest control point on offer.
- Known adapters at authoring time: Zed's `claude-code-acp` (npm) wrapping
  Claude Code; Gemini CLI's native ACP mode. The spike re-surveys the
  landscape (goose, opencode, others move monthly).

## Architecture

### `coder` sidecar (new compose service, optional profile)

Node + git + the ACP adapter(s), operator-registered repos mounted into
THIS container only — the backend never mounts workspaces. No published
ports; backend-network only. A thin **session broker** inside it (the
inference-control house pattern: narrow fixed API, no parameterized
shell): `POST /session` spawns an agent subprocess for one task and
bridges its stdio JSON-RPC over a WebSocket the backend attaches to;
`GET /session/<id>` reports state; `POST /session/<id>/kill` enforces the
wall clock. The broker holds NO Nova secrets (no NOVA_AUTH_TOKEN, no
OpenRouter key) — only the coding agent's own credentials.

### Workspaces + git discipline

Operator registers repos in Settings (edit-mode gated; a `workspaces`
table — path, name, enabled). Every session runs on a **fresh worktree
under `.worktrees/nova/<task-slug>`** inside the repo (matches the
worktrees-internal policy: inside the repo, gitignored, never siblings).
Sessions never touch main, never commit to it, never push — output is a
worktree branch + diff, merge is ALWAYS the operator's move (the
commit-only-when-asked rule, applied to delegates).

### Session lifecycle — background job, not a chat turn

Coding sessions run minutes; Nova's tool rounds don't. So sessions are
background jobs in the automations mold:

- `delegate_coding_task(workspace, task)` builtin: creates a session row,
  kicks the broker, returns the session id immediately — Nova answers
  "started, I'll report when it lands" (a TRUE statement, unlike
  narration: the detector sees a real tool call).
- Progress streams from the broker into the activity trail while the chat
  is open; a `check_coding_session(id)` builtin answers "how's it going".
- Completion journals a report (branch, diffstat, agent summary, test
  results if run) and — once ntfy is wired (#21) — notifies the phone.
- Wall-clock kill: per-session budget (setting, default 30 min), enforced
  by the broker; the v2 rails design is the reference.

### Permission policy (v1: sandboxed-autonomous)

Two candidate modes; v1 ships the first:

1. **Sandboxed-autonomous (v1 default)**: inside an isolated worktree in
   a secretless container, auto-approve file edits within the worktree
   and an allowlisted command set (test/build/lint runners); deny
   network fetches, global installs, and paths outside the worktree;
   anything denied is logged in the session report. The real gate is the
   diff review — nothing merges without the operator.
2. **Interactive approvals (later)**: per-request approve/deny surfaced
   in chat. Needs new UI machinery and an operator who's present;
   valuable once an approvals/inbox surface exists (a v2 port candidate).

### Credentials + product-principles honesty

Claude Code runs on the operator's Anthropic credentials, Gemini CLI on
Google's — **coding delegation is a keyed opt-in extra**, exactly the
posture the product principles allow. Batteries-included coding (a local
model driving an ACP-speaking harness — the roadmap's Ornith-35b note
belongs here) is phase 4 research, not promised. Delegated cloud spend is
invisible to Nova today; note it as a customer for #16 (usage caps) once
cost capture exists.

## Phases (one per session; phase 0 gates everything)

0. **Research spike (no repo code).** In a scratch container: run
   `claude-code-acp` and Gemini CLI's ACP mode by hand with a minimal
   JSON-RPC driver; map the real frames (session lifecycle, streaming
   updates, permission requests, FS mediation, cancellation); confirm
   worktree cwd + non-interactive auth work; re-survey adapters.
   Deliverable: findings appended to this doc, adapter choice, go/no-go.
   If FS mediation or permissioning can't confine the agent, STOP and
   redesign before any build.
1. **Coder sidecar + broker + workspace registry.** Compose service,
   broker verbs, migration + Settings card (edit-mode gated). Verify:
   session spawned by hand against a scratch repo produces a worktree
   branch with a real edit; broker unreachable from host; kill verb works.
2. **Chat integration.** `delegate_coding_task` + `check_coding_session`
   builtins (granted to main — dispatch depth is capped at 1, so no
   liaison agent; the builtin IS the delegation), session table, activity
   streaming, completion journal. Verify through :5173: ask Nova to make
   a small real change in a registered repo; watch progress in the
   activity trail; journal report lands; branch + diff exist and main is
   untouched.
3. **Policy engine + review surface.** Worktree confinement + command
   allowlist enforced in the broker (or via FS mediation per spike
   findings); session report renders branch/diffstat/denials in chat with
   a copyable `git diff` invocation. Verify: an out-of-worktree write and
   a non-allowlisted command are denied and reported; allowed test run
   passes through.
4. **Local-model lane (research).** Evaluate ACP-speaking local options
   (Ornith-35b on the 3090 per the roadmap note; goose/opencode-class
   harnesses). Deliverable: findings, not code.

## Ordering + dependencies

- **Build after #3 (observability)** — an agent editing code on your
  machine without an audit trail is flying blind; the turn ledger and
  audit log are the safety substrate this rides on.
- ntfy (#21) makes completion alerts real; without it, reports are
  journal + chat only. Not blocking.
- MCP (#19) is independent — neither needs the other.

## Decisions needed from Jeremy (everything above proceeds without them)

1. **First agent**: claude-code-acp or Gemini CLI? (Plan assumes spike
   decides on merit; claude-code-acp is the bet.)
2. **Which repos** get registered first (host paths to mount — likely
   `~/workspace/*` picks, but that's your call at setup, not a design
   question).
3. **Session budget default**: 30 min wall clock assumed.
