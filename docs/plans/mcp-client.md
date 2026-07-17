# MCP client — connect Nova to the tool ecosystem

Implementation plan (authored 2026-07-17 with Fable). Origin: Jeremy wants
MCP integration "probably soon". Today every Nova capability is hand-built
(builtins + tool-creator's HTTP tools); an MCP client makes Nova a consumer
of the ecosystem — GitHub, Home Assistant, filesystems, calendars — without
authoring each integration. Decisions are flagged for Jeremy at the bottom;
everything else is settled here.

## What exists (verified in code, 2026-07-17)

- **Zero MCP code in v3** (grep across `backend/app`). This is greenfield.
- **A single dispatch choke point**: every tool call goes through
  `execute_tool` (`backend/app/tools/registry.py:160`), called from
  `runner.py:334`. Grant refusal (names not offered to the calling agent),
  guardian rule checks, and the narration detector all key off this path —
  MCP tools MUST flow through the same funnel to inherit all three for free.
- **The grant model**: `get_agent_tools` builds each agent's tool list from
  `allowed_tools` — named grants or the `db:*` wildcard. MCP mirrors this.
- **Reference designs in `v0.5.0-alpha`** (mine ideas, never code):
  - *MCP lazy tool loading* (old-repo PR #54): index + meta-tool +
    per-server `always_inject` toggle, so N servers don't blow up every
    prompt. This design shipped and was live-verified in v2 — port the
    shape, not the code.
  - *MCP consent gate* (autonomy-core lane): per-call consent for sensitive
    MCP tools. v3's equivalent primitives are guardian rules + edit-mode
    gating; a richer approvals surface is a later port.
- **Python backend**: the official `mcp` SDK (pip) speaks both transports —
  phase 1 needs only a dependency, no new service. Verify the current SDK
  API at build time; it moves.

## Design

### Registry (migration — check next free number; 025 at time of writing)

```sql
mcp_servers (
  id           uuid pk,
  name         text unique,      -- short slug, used in tool namespacing
  transport    text,             -- 'http' | 'stdio' (stdio lands phase 4)
  url          text null,        -- http transport
  command      text null,        -- stdio transport (phase 4, runs in sidecar)
  enabled      boolean default false,
  always_inject boolean default false,  -- lazy-loading override
  tools_hash   text null,        -- hash of tool names+descriptions at approval
  status       text,             -- connected | error | disabled
  last_seen    timestamptz null
)
```

**Registration is operator-only** — Settings API, edit-mode gated (403s),
NO agent-facing `manage_mcp_servers` tool. This is the #18 self-escalation
lesson applied preemptively: an agent that can register a tool server can
grant itself arbitrary capabilities. Nothing an agent can write may be the
switch.

### Namespacing + grants

MCP tools surface as `mcp:<server>/<tool>` in the catalog. Grants follow
the `db:*` precedent: named grants or `mcp:<server>:*` (all tools of one
server). There is deliberately NO global `mcp:*` wildcard — each server is
a distinct trust decision.

### Dispatch integration

`get_agent_tools` merges granted MCP tools (defs cached from the server's
`tools/list`, refreshed on connect + on a TTL); `execute_tool` routes
`mcp:`-prefixed names to the client session. Guardian rules match the
namespaced name (per-tool targeting works unchanged); the
no-secret-in-requests rule watches outbound args exactly as it does for
HTTP tools. Timeouts: per-call wall clock (default 30s, setting), result
size cap (200KB, matching web_fetch's posture).

### Lazy loading (the v2 design, ported)

Granted-but-not-injected servers contribute ONE index line to the prompt
("server `github`: 31 tools — use `find_mcp_tools` to search") plus a
`find_mcp_tools(query)` meta-tool that returns matching defs; the runner
adds found tools to the live turn's toolset. `always_inject=true` servers
skip the index and inject all defs (right for small, hot servers).

### Security posture

- **Tool-description poisoning**: server-supplied descriptions land in
  agent prompts — that's an injection channel. At registration (and
  reconnect) the tool list + descriptions are hashed into `tools_hash`;
  a hash change flips the server to `error` status and disables its tools
  until the operator re-approves in Settings (the soul.md hash-sync
  pattern). The registration UI shows full descriptions for review.
- **Results are untrusted content** — same standing as web_fetch output.
  No new mitigation needed beyond what prompts already say, but the
  guardian can target specific servers with block/warn rules.
- **Secrets**: server credentials (API keys in env/headers) live in .env
  for now; this item is another customer for the in-UI secrets store
  (Later). Memory files never hold them (checked policy).
- **Network**: operator-registered URLs only — agents never supply
  endpoints, so the SSRF guard stays where it is (web_fetch).

### UI

MCP lives in the existing **Tools tab** (everything callable in one
place): a "Servers" section above the tools list — server cards with
status dot, tool count, enable switch, always_inject toggle, and a
"review tools" expander (names + descriptions, the hash-approval
surface). Edit-mode gates create/edit/delete; enable/disable stays open
(matching agents/automations). Walk the click path (memory rule:
discoverable by navigation).

### Batteries-included note

MCP servers are opt-in extras by nature (most need accounts/keys) — this
does NOT violate the no-key-collecting principle because the base product
stays fully functional without any. A small curated preset list (Home
Assistant, filesystem, fetch-class servers) ships as documentation +
one-click templates, all disabled by default. Nothing auto-connects.

## Phases (one per session)

1. **Client core + registry + HTTP transport.** Migration, `mcp_client.py`
   (connect, list_tools, call_tool via the `mcp` SDK), bridge into
   `get_agent_tools`/`execute_tool`, grants + guardian verified at the
   choke point. Verify: register a reference HTTP server (run one in a
   scratch container), grant it to main, real chat turn calls an MCP tool
   through :5173; ungranted name refused; a guardian block rule on the
   namespaced name enforced live.
2. **Lazy loading.** Index line + `find_mcp_tools` + `always_inject`.
   Verify: with a many-tool server granted, prompt carries only the index
   line; a chat turn discovers then calls a tool in one conversation.
3. **Settings UI.** Servers section in Tools tab, status dots, tool
   review + hash approval flow, edit-mode gating. Verify: full click
   path; 403s with edit mode off / CRUD on; hash-change flag fires when
   the server's tool list mutates.
4. **stdio via `mcp-runner` sidecar + presets.** New compose service
   (node + uv image — the runtimes stdio servers need that the backend
   image lacks), no published ports, backend-network only; a thin exec
   bridge in the inference-control style (fixed verbs, no
   parameterized shell). Preset templates documented in README. Verify:
   a filesystem server scoped to a scratch mount callable from chat;
   sidecar unreachable from the host.

## Relationship to #18 (executable skills)

A chunk of what "executable skills" would provide is better answered by
"an MCP server exists for that." The #18 research task should treat this
plan as a live alternative and define the boundary: skills = prompt
steering + procedure knowledge; MCP = executable capability with an
out-of-band trust decision. Evaluate together before building either
further.

## Decisions needed from Jeremy (everything above proceeds without them)

1. **Default grant posture**: plan assumes NO server is granted to any
   agent automatically — the operator grants per agent after registering.
   Alternative: auto-grant new servers to main. (Plan assumes manual.)
2. **Tab placement**: Servers inside the Tools tab (plan default) vs. a
   dedicated MCP tab.
3. **Phase 4 scope**: is stdio-in-sidecar worth it early, or is the HTTP
   ecosystem enough for months? (Plan assumes build it fourth, skippable.)
