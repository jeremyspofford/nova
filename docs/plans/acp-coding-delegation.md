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

2026-07-24: the team layer above this — roles as pipeline stages (spec /
tests / implement / review / browser QA), operator checkpoints, push +
deploy verbs — is specified separately in `coding-team-pipeline.md`.
This plan is the substrate that layer drives; build this first.

## Protocol essentials (validate in phase 0)

> **PHASE 0 RAN, 2026-07-31. Read "Phase 0 findings" at the bottom before
> this section — three of the bullets below are now known to be wrong, and
> the fourth is the one the stop condition fired on.**

- JSON-RPC over stdio between a client (editor/orchestrator — here, Nova)
  and an agent subprocess. Spec: agentclientprotocol.com.
- Session-based: initialize → create session (cwd = the workspace) →
  prompt turns; the agent streams updates (plans, tool-call reports, text)
  as it works.
- ~~**The client owns permissions**: the agent ASKS the client before tool
  use (`session/request_permission`-class calls); the client can also
  provide the filesystem (agent reads/writes THROUGH client-side methods).
  If FS mediation holds up in the spike, Nova's broker can enforce
  worktree confinement at the protocol level, not just the container
  level — confirm this, it's the strongest control point on offer.~~
  **DISPROVEN — see findings. The client does not own permissions; the
  agent does, and asking is `MAY`. FS mediation does not confine and is
  deleted in ACP v2.**
- ~~Known adapters at authoring time: Zed's `claude-code-acp` (npm) wrapping
  Claude Code~~ **— that package is deprecated and renamed; see findings.**
  Gemini CLI's native ACP mode. The spike re-surveys the
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

> **CORRECTION (2026-07-25, docs/plans/capability-and-containment.md):** a
> git worktree is NOT a portable containment unit. Its `.git` is a `gitdir:`
> pointer to an absolute path in the parent repo, and commits inside it
> write refs into the parent's `.git/refs/heads` — so mounting "just the
> worktree" requires the parent `.git` writable at the same absolute path
> inside the container, which is the opposite of confinement. Rename the
> parent and git dies with `fatal: not a git repository`. Replace the
> mounted-worktree design below with: clone into a private volume, export
> with `git bundle`. That also makes the LOCKED operator-merge gate
> mechanical rather than procedural. Phase 0 should NOT re-derive this.
> Also: ban ACP's `auto` permission mode explicitly.

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
   agent-initiated network fetches beyond the container's egress
   allowlist (a phase-0 deliverable — see below), global installs, and
   paths outside the worktree; anything denied is logged in the session
   report. The real gate is the
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
   Deliverable: findings appended to this doc, adapter choice, go/no-go,
   plus a concrete egress allowlist for the coder sidecar — the adapter
   must reach its own API (api.anthropic.com / Google endpoints) and a
   later push verb needs the git host, so the policy is a destination
   allowlist, not a blanket network deny; package-registry installs stay
   denied. If FS mediation or permissioning can't confine the agent,
   STOP and redesign before any build.
1. **Coder sidecar + broker + workspace registry.** Compose service,
   broker verbs, migration + Settings card (edit-mode gated). Verify:
   session spawned by hand against a scratch repo produces a worktree
   branch with a real edit; broker unreachable from host; kill verb works.
2. **Chat integration.** `delegate_coding_task` + `check_coding_session`
   builtins (granted to main — dispatch depth is capped at 1, so no
   liaison agent; the builtin IS the delegation), session table (designed
   with a nullable `task_id` FK so the `coding-team-pipeline.md` stage
   machine extends it later rather than migrating it), activity
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

1. ~~**First agent**: claude-code-acp or Gemini CLI?~~ **Settled by the
   spike: `@agentclientprotocol/claude-agent-acp`. See findings.**
2. **Which repos** get registered first (host paths to mount — likely
   `~/workspace/*` picks, but that's your call at setup, not a design
   question).
3. **Session budget default**: 30 min wall clock assumed.

---

# Phase 0 findings (ran 2026-07-31)

Measured, not surveyed. The driver and the three confinement cases are
reproducible; what follows separates what was **observed on this machine**
from what the **specification guarantees**, because those turned out to
disagree in the direction that matters.

## 1. The bet holds; the package in this plan is dead

`@zed-industries/claude-code-acp` carries an npm deprecation notice —
"This package has been renamed to @agentclientprotocol/claude-agent-acp" —
and its last real publish was **0.16.2 on 2026-02-17**. The live adapter is
**`@agentclientprotocol/claude-agent-acp` 0.64.0, published 2026-07-30**,
five releases in the preceding ten days.

The whole project moved out of Zed's org:
`github.com/zed-industries/agent-client-protocol` 301-redirects to
`github.com/agentclientprotocol/agent-client-protocol`, now jointly governed
by Zed and JetBrains and explicitly "working toward transitioning to an
independent foundation." Claude Code has **not** gained native ACP, so an
adapter is still required. It now wraps `@anthropic-ai/claude-agent-sdk`
(0.3.220), not the Claude Code CLI binary.

Target it. It has the highest release cadence in the ecosystem, tri-vendor
authorship, and the richest surface (permissions, terminals, MCP, session
resume). `@agentclientprotocol/codex-acp` (OpenAI) and `@google/gemini-cli`
exist as alternates and make the adapter layer a registry rather than a
choice — see §5.

## 2. THE STOP CONDITION FIRED: ACP is cooperative, not enforcing

The plan said: "If FS mediation or permissioning can't confine the agent,
STOP and redesign before any build." It cannot. **Do not build worktree
confinement on ACP. Containment is the container.**

What was measured here (adapter 0.64.0, driven over stdio, verdict taken
from `os.path.exists` rather than from the transcript):

| Case | Asked? | Wrote outside cwd? |
|---|---|---|
| `default` mode, client declines `fs`, we deny the request | yes | **no** |
| `bypassPermissions` | no | **YES — escaped** |
| `dontAsk`, nothing pre-approved | no | no |

So today, with this adapter, denial genuinely prevents the write, and
`dontAsk` is deny-by-default as advertised. That is better than a reading of
the source predicted, and it is why this was measured rather than inferred.

But the protocol guarantees none of it, and five independent facts say the
cooperation is voluntary:

1. Asking permission is **`MAY`**, in both v1 and v2 — never `MUST`.
   Reporting a tool call at all is only `SHOULD`.
2. `session/request_permission` is **not in the agent baseline MUST list**
   (only `session/new`, `session/prompt`, `session/cancel`,
   `session/update`). An agent that never asks is fully compliant.
3. An agent can move **itself** into a non-asking mode and merely notify via
   a `current_mode_update` **notification** — which the client cannot veto.
   (The payload field is `currentModeId`; the spec prose says `modeId` and
   the spec prose is wrong — the schema and the shipping adapter both use
   `currentModeId`. `modeId` is the field on the client→agent
   `session/set_mode` request.)
4. Declining the client `fs` capability changes nothing. Across all three
   cases above the agent made **zero** `fs/*` calls — it used the Agent
   SDK's own in-process `Read`/`Write`/`Edit`/`Bash`, which reach the OS
   directly. `cwd` is not a boundary: case B wrote outside it freely.
5. It is not hypothetical. GitHub Copilot CLI auto-approved everything in
   `--acp` mode with no permission requests at all (issue #845).

**And the mechanism is being deleted.** ACP **v2 was published in draft on
2026-07-20**. Counted from the machine-readable `meta.json` shipped with
each schema release rather than from prose, **the client surface collapses
from nine methods to two** — only `session/request_permission` and
`session/update` survive. Gone: `fs/read_text_file`, `fs/write_text_file`,
and every `terminal/*` (`create`, `output`, `release`, `wait_for_exit`,
`kill`). Also gone from the agent side: `session/load` and
`session/set_mode`; `authenticate`/`logout` become `auth/login`/`auth/logout`.
The turn model inverts — `session/prompt` returns a bare `{}` on acceptance
and completion arrives as a `state_update` (`running` | `idle` |
`requires_action`) carrying `stopReason`.

The RFD's rationale is that the surface "has not been widely adopted by both
Clients and Agents, and many Agents are moving toward their own sandboxing
and execution configuration instead." Its recommended replacement matters
for us: "If clients want to offer specialized tooling in these areas, they
can already expose a special MCP server to the agent." Nova is already an
MCP client (#19), so **if we ever want mediated file access it arrives as an
MCP server we host, not as an ACP capability** — a different and better-known
shape. v2 keeps a `terminal` content type, but it is display-only and
Agent-owned: no input, resize, interrupt, kill, or execution semantics.

Timing guidance is explicit in the v2 announcement and worth obeying: "gate
your implementation behind the version negotiation AND feature flags. Don't
ship it by default in production until we are closer to stabilization," and
"Adding v2 support should not mean dropping v1." Build phase 1 on v1, pin the
version, and treat v2 as a watch item.

Transport is unchanged and still **stdio-only** in the normative spec for
both versions — Streamable HTTP is "in discussion" with a Transports Working
Group formed 2026-04-22. The broker's WebSocket bridge stays a Nova-side
concern, not something the protocol will hand us soon.

This is `CLAUDE.md`'s rule arriving from outside the codebase: the agent's
permission layer is a **promise**, and a promise is not a control. Keep it —
it is real defence-in-depth and it demonstrably works today — but the line
that refuses when the agent is wrong has to be the container.

**Mode policy, now evidence-backed.** The plan says ban `auto`. Correct, and
for a sharper reason than it knew: `auto` is *"Use a model classifier to
approve/deny permission prompts"* — an LLM adjudicating permissions, which
is the exact shape this codebase refuses everywhere else. But the ban must
also cover **`bypassPermissions`**, which is the mode that actually escaped
above and which the plan never mentions. And the mode that fits
sandboxed-autonomous is **`dontAsk`** (deny unless pre-approved), not
`acceptEdits`. Six modes exist: `auto`, `default`, `acceptEdits`, `plan`,
`dontAsk`, `bypassPermissions`.

Because v2 removes `session/set_mode`, mode selection is in flux — pin the
adapter version and re-check on upgrade.

## 3. Frames, as observed

`initialize` → `session/new` → `session/prompt`, streaming
`agent_thought_chunk` / `agent_message_chunk` / `usage_update` notifications,
terminating in a response carrying `stopReason` and a `usage` block
(`inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`).
So **the protocol does carry cost data** — the plan's "delegated cloud spend
is invisible to Nova" is no longer true, and #16 usage caps can consume it.

`agentCapabilities` advertises `loadSession: true` and session
`resume`/`fork`/`list`/`close`/`delete`, so resumption exists. `authMethods`
came back **empty**: auth is entirely out-of-band, so the sidecar carries the
credential. `session/new` **succeeds with no credential at all** — a session
can look healthy and be dead, and the broker must surface auth failure from
the first prompt rather than from session creation.

## 4. It runs on the key Nova already has — no new credential

The plan calls coding delegation "a keyed opt-in extra" needing the
operator's Anthropic or Google credentials. **Not required.** The Agent SDK
honours `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, and OpenRouter serves
a genuine Anthropic-Messages-shaped endpoint at
`https://openrouter.ai/api/v1/messages`. A full ACP turn was driven
end-to-end on Nova's existing `OPENROUTER_API_KEY`: real streaming,
`stopReason: end_turn`, 38,950 tokens billed.

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api   # NOT .../api/v1 — the SDK appends /v1/messages
ANTHROPIC_AUTH_TOKEN=<OPENROUTER_API_KEY>      # must be set together with BASE_URL
```

A bare `claude-opus-4-6` resolves at the gateway, so no model-override map is
needed. This puts coding delegation back inside the batteries-included
principle instead of outside it.

## 5. Any provider, one adapter

Through that same Anthropic-shaped endpoint, all returning proper
`type: "message"` responses: `google/gemini-2.5-flash`,
`openai/gpt-4o-mini`, `moonshotai/kimi-k2`,
`meta-llama/llama-3.3-70b-instruct`. So the adapter is mechanically
provider-agnostic and maps straight onto Nova's existing provider registry
(`slug:model`, bring-your-own-key) rather than needing a new credential
concept.

Stated honestly: this proves the **transport** is provider-agnostic. It does
not prove a non-Claude model *codes well* through a harness whose prompts and
tool definitions are tuned for Claude. That is a quality question and it
belongs to the eval pipeline — the turn-speed lane already learned this once.

## 6. Egress

Anthropic publishes a current allowlist at
`code.claude.com/docs/en/network-config` (14 hosts). The `init-firewall.sh`
that every blog post cites is **11 months stale** — it still lists
statsig/sentry, which the live docs have replaced with Datadog intake hosts.
Do not copy it.

If the sidecar goes through OpenRouter, the required destination is
`openrouter.ai`, not `api.anthropic.com`, which shortens the list
considerably. `api.anthropic.com` is CIDR-expressible (`160.79.104.0/23`);
Google's endpoints are not CIDR-separable, so a Gemini-native adapter would
need a proxy rather than an ipBlock.

**Concrete blocker if the sidecar ever becomes a k8s workload rather than a
compose service:** `allow_host_egress` refuses public CIDRs (it gates on
`_is_private`, `workloads.py`), and `allow_internet_egress` is blanket. There
is no verb today that opens one public host. That is a gap to close before
phase 1 if the runtime moves.

## Verdict

**GO on ACP as the integration surface, NO-GO on ACP as a security
boundary.** Phases 1–3 stand with one rewrite: strike "enforce worktree
confinement at the protocol level" wherever it appears and treat the
permission layer as defence-in-depth over a container that is the actual
boundary. The plan's own correction note (a git worktree is not a portable
containment unit — clone into a private volume, export with `git bundle`)
becomes more load-bearing, not less, because it is now the only boundary.
