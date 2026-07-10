# Autonomy Core — Plan (2026-07-09)

> **Branch:** `feature/autonomy-core` (off `main` @ 38f4150). **Migration range:** 105–119.
> **Parallel session:** a second Claude owns `/brain` (`Brain.tsx`, `dashboard/src/brain/*`,
> memory-service graph endpoint). Do not touch those; defer the Brain+Knowledge nav merge.
>
> **Goal (Jeremy, 2026-07-09):** make Nova *the most autonomous agent* — able to act broadly
> on the world — with Home Assistant / n8n / DNS (Pi-hole) / email shipping as **very easy,
> safe, configurable additions**, plus a **simulation/dry-run** tier before world-affecting
> actions. Depth and quality over speed.

## What already exists (verified, build on it — don't rebuild)

- **Consent gate** (`orchestrator/app/capabilities/consent.py`): every action *that flows
  through it* is classified by `BlastRadius` (READ/PROPOSE auto-allow; MUTATE/DESTRUCT →
  match consent rules or create a pending approval + push notification with signed
  Approve/Deny). Approved actions re-execute via the **approval worker** off a Redis queue.
  Full **audit** (`capability_audit`, blast_radius-tagged) and an **encrypted credential
  vault** (`credentials.py`, AES-GCM under `CREDENTIAL_MASTER_KEY`).
- **MCP registry** (`orchestrator/app/pipeline/tools/registry.py`): DB-backed `mcp_servers`
  table (migration 004: transport stdio/http, command, args, env, url, enabled, metadata),
  stdio + HTTP clients, startup load, hot-reload, disconnect, namespaced tool dispatch
  (`mcp__{server}__{tool}`), activity logging, live status. CRUD at
  `/api/v1/mcp-servers` (`pipeline_router.py:935+`, admin-gated).
- **Roadmap already blesses this arc**: "MCP Integrations Hub `[spec]`" (Home Assistant,
  n8n, Docker, filesystem, Brave as priority integrations; `mcp-servers.yaml`; health;
  hot-reload) and "Reactive Event System `[spec]`" (Redis Streams event bus, event→reaction,
  quiet hours, circuit breakers). We are *executing specs*, not inventing.

## The crux finding — MCP bypasses the consent gate 🔴

**`orchestrator/app/tools/__init__.py:182`** dispatches any `mcp__*` tool **directly** to
`execute_mcp_tool()`. Only `github_external` tools (line 193) route through the capability
platform's consent gate. So **MCP tool calls today get no blast-radius classification, no
approval, and no capability audit** — only `check_hard_rules()` (a denylist, line 172) and
best-effort after-the-fact `_log_mcp_activity`.

**Consequence:** the moment Home Assistant / n8n / a DNS controller is added as an MCP
server, the agent can `lock.unlock`, open a garage cover, flush a Pi-hole blocklist, or
fire a destructive n8n workflow **with zero consent**. Every integration Jeremy wants is,
today, an ungated world-affecting capability.

**Therefore the #1 prerequisite for safe integrations is not the catalog — it's routing
MCP through the consent gate with per-tool blast-radius classification.** That single change
makes "most autonomous" and "safe" the same design, and every subsequent slice inherits
consent/approval/audit/simulation for free.

---

## Sequenced slices (each PR-sized; Slice 0 fully specced)

### Slice 0 — Route MCP through the consent gate (SAFETY PREREQUISITE) · migration 105
The keystone. Classify every MCP tool's blast radius and run MCP calls through `consent.gate`
before `execute_mcp_tool`.

- **Classification.** Default an MCP tool to **MUTATE** (fail-closed — the ToolDefinition
  contract already defaults `blast_radius=MUTATE`, `nova_contracts/llm.py:83`). Refine via,
  in precedence order: (1) explicit per-tool override in the server's `metadata.tool_blast_radius`
  map; (2) a built-in **classifier** by tool-name/verb heuristics (`get`/`list`/`read`/
  `search`/`state`→READ; `set`/`turn_on`/`unlock`/`open`/`delete`/`create`/`run`→MUTATE/
  DESTRUCT) shipped per catalog template; (3) the MUTATE default. READ/PROPOSE stay
  auto-allow so read-only MCP tools (search, sensor reads) don't nag.
- **Enforcement.** In `tools/__init__.py`, before `execute_mcp_tool`, resolve blast radius +
  `provider_kind`/`target` from arguments and call `consent.gate(...)` with `tool_kind` =
  `mcp_http`/`mcp_stdio`. On `pending`, return the consent-pending envelope (same shape as
  github_external) so the agent surfaces the approval id. On `allow`, execute + write a
  `capability_audit` row. Wire `execute_approved` (executor.py) to re-run a pended MCP call
  (new `tool_kind` branch) so the approval worker resumes it.
- **Migration 105**: `mcp_tool_classifications` (or extend `mcp_servers.metadata`) — persist
  per-tool blast-radius overrides an operator sets from the UI.
- **Tests**: `test_mcp_consent_gate.py` — a MUTATE MCP tool pends; a READ one auto-allows; an
  operator override downgrades; approval worker re-executes an approved MCP call.
- **Verify**: add a throwaway echo MCP server, confirm a "write" tool pends in Pending
  Approvals and a "read" tool runs, per [[test-real-user-flow]].

### Slice 1 — Integration Catalog · migration 106 (if needed)
Curated templates so adding HA is 2 fields, not a raw command line.
- `mcp_catalog.py`: templates for **Home Assistant, n8n, Docker, filesystem, Pi-hole/AdGuard,
  Brave**. Each declares transport, command/image or URL pattern, required fields (with
  secret-vs-plain marking), and the per-tool blast-radius classifier from Slice 0.
- `GET /api/v1/mcp-servers/catalog` and `POST /api/v1/mcp-servers/install` (materializes an
  `mcp_servers` row from template + fields; **secret fields → `platform_secrets`**, never
  plaintext env). Reuses existing CRUD/connect.

### Slice 2 — Integrations dashboard page
Revive the dead `dashboard/src/pages/MCP.tsx` (UX-013) as a navigable **Integrations** page:
catalog gallery → install modal → installed list with live health + per-tool blast-radius
badges + an operator override control. Append-only to `api.ts` (coordinate w/ Brain session).

### Slice 3 — Simulation / dry-run tier
A `dry_run` mode on the gate/executor: for high-blast-radius or multi-device actions, produce
a **projected effect** ("would turn off 4 lights, lock 2 doors") for confirmation before real
execution. Slots into the existing approval/checkpoint machinery (the `diff_preview` field on
`approval_requests` is the natural carrier). Adds a "propose → simulate → confirm → execute"
path and a per-capability "always simulate first" policy.

### Slice 4 — Reactive Event System (v1) · migrations 107–108
Redis Streams event bus + typed events. Adapters: **webhook receiver** and **HA state-change
subscription** first. Event → declarative subscription rule → cortex stimulus (reuse the
existing stimulus loop) → Nova *reacts* ("back door opened after 22:00 → alert + arm").
Safety: rate limits, **quiet hours**, circuit breakers, destructive-action confirmation
(inherits Slice 0's gate). This is what makes autonomy *proactive*, not just responsive.

### Slice 5 — Sensitivity router (privacy keystone)
`llm-gateway`: a content-sensitivity classifier forces `local-only` routing for flagged
content (it never leaves the box) while non-sensitive traffic may use cloud. Pair with a
**per-message provider badge** (PRIV-013) so the operator always sees who saw a prompt. This
is the honest "as encrypted as possible" answer — the one unavoidable leak (cloud LLM sees
plaintext) is closed by keeping sensitive content on local inference.

### Slice 6 — Consent inbox + Activity feed (dashboard, net-new)
First-class approval triage surface (approvals + checkpoints in one place; the signed-ntfy
actions already exist) and the unified "what did Nova do today?" run/activity feed (NSI-003).
Net-new pages, append-only to `api.ts` and routes — no restructuring of existing pages.

---

## Adjacent net-new fixes to fold in opportunistically
- **NEW-01** (sandbox `startswith` boundary, `code_tools.py:257/266`) — one-line
  `is_relative_to` fix; land early since Slice 0 touches the tool layer.
- MCP tools should also pass through the **idempotency ledger** (`tool_idempotency.py`) the
  way native tools do (line 209) — a reactive re-fire shouldn't double-act.

## Non-goals / deferred
- HA *native* integration (scene/automation CRUD, long-lived websocket) stays deferred per
  `docs/superpowers/specs/2026-07-06-home-assistant-native-integration-future.md` — MCP path
  first; native only when a trigger fires.
- Brain+Knowledge nav merge — deferred until the parallel /brain work lands.

## Sequencing
Slice 0 first, always (safety). Then 1→2 (integrations usable end-to-end), then 3 (simulation)
and 5 (privacy) in parallel-ish (independent), then 4 (reactive) and 6 (surfaces). Ship docs
with each slice per [[document-as-we-ship]]; verify against the running stack per
[[test-real-user-flow]].
