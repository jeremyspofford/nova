# Nova-as-MCP-Server (Capabilities Surface) — Design

> **Status:** Design / product-direction. Not yet implemented.
> **Date:** 2026-07-06
> **Owner:** Jeremy
> **Roadmap:** Priority Backlog (product path) — see `docs/roadmap.md`

## Why

Nova already consumes external MCP servers as tools (`orchestrator/app/pipeline/tools/mcp_client.py`, `http_mcp_client.py` — stdio + Streamable HTTP clients). But the **reverse direction is missing**: Nova does not expose itself as an MCP server. External agents and IDEs that speak MCP (Cursor, Claude Code, Continue, Zed, any MCP-aware client) cannot call into Nova's memory, goals, or task surface without each building a bespoke HTTP integration.

This matters because Nova's value is its **memory and orchestration brain** — and right now that value is reachable only through Nova's own dashboard and chat. An external coding agent working in Cursor has no way to `search_memory` or `recall_topic` from Nova's knowledge graph mid-edit. Exposing Nova as an MCP server makes Nova a **composable tool in the broader agent ecosystem**, not just a standalone app.

**Critical distinction — this is NOT an ingestion pipe.** MCP's semantics are request/response tool invocation, designed for an LLM agent deciding "I'll call `search_memory` now." It is the wrong abstraction for high-volume push ingestion (see `docs/superpowers/plans/2026-07-06-generalized-ingestion-endpoint.md` for that). This spec covers **capabilities outward**; ingestion is a separate, HTTP-based surface.

## What ships

An MCP server endpoint on the orchestrator exposing a curated subset of Nova's capabilities as MCP tools, over the Streamable HTTP transport (the same transport Nova's `HTTPMCPClient` already speaks as a client).

### Transport

- **Streamable HTTP** (MCP 2024-11-05 spec) at `POST /api/v1/mcp` (and an SSE stream for server→client notifications when added).
- One Nova instance = one MCP server. Multi-tenant scoping follows the authenticated principal (API key → tenant_id), same as all other Nova endpoints.
- Reuse the existing FastAPI app on the orchestrator (port 8000) — no new service.

### Auth

- **API key** (`Authorization: Bearer sk-nova-*`), the same keys Nova already issues and rate-limits. No new auth model.
- Key role gating applies: a `member`-role key can read memory + create tasks; a `viewer` key is read-only; `guest` keys are denied (consistent with guest isolation).
- MCP's OAuth flow is not required — Nova already has a bearer-token auth model that fits. (If a remote MCP client demands OAuth, that's a later phase; local/LAN clients use the API key directly.)

### Tools exposed (v1 — read-heavy, safe)

Mirror the agent-facing tools that already exist in `orchestrator/app/tools/`, exposed outward:

| MCP tool | Backs onto | Purpose |
|---|---|---|
| `search_memory` | memory-service `POST /api/v1/memory/context` (query mode) | Ranked retrieval for a query |
| `recall_topic` | memory-service `GET /api/v1/memory/items?...` | Comprehensive recall about one entity/topic |
| `what_do_i_know` | memory-service `GET /api/v1/memory/stats` + root index | Lightweight overview of what's stored |
| `read_memory` | memory-service `GET /api/v1/memory/items/{id}` | Full content of one memory item |
| `list_goals` | orchestrator `GET /api/v1/goals` | Active goals + status |
| `get_goal_status` | orchestrator `GET /api/v1/goals/{id}` | Single goal detail + iterations |
| `create_task` | orchestrator `POST /api/v1/pipeline/tasks` | Submit a task for the pipeline (role-gated) |

**Deliberately NOT exposed in v1:**
- Write tools that modify memory (`remember`) — requires the consent/confirmation model that doesn't exist for external callers yet.
- Self-modification / config tools — security-sensitive, out of scope.
- Push ingestion — use the HTTP ingestion endpoint, not MCP.

### Resources (optional, phase 2)

MCP "resources" are pull-oriented (server exposes, client reads). A natural fit: expose the memory journal and topic files as readable resources (`memory://journal/2026-07-06`, `memory://topics/<slug>`). This is additive and low-risk once tools are stable.

## Relationship to existing surfaces

- **OpenAI-compatible endpoints** (`/v1/chat/completions`, `/v1/models`) already let IDEs use Nova as a model backend. MCP is the **complement**: where the OpenAI surface gives an IDE Nova's *model*, the MCP surface gives an agent Nova's *brain* (memory + goals). The two are independent and both valuable.
- **Internal MCP client** (Nova calling external MCP servers as agent tools) is unchanged. This spec adds the server direction; the client direction already ships.
- **Internal agent tools** (`orchestrator/app/tools/*`) are the implementation source — the MCP server is a thin adapter wrapping the same backing calls, not a parallel implementation.

## Security model

- Every tool call is **auth-gated** (API key + role) and **audit-logged** (existing `audit_log` table) — same posture as the admin/REST API.
- Rate limiting reuses the existing per-key Redis sliding window.
- SSRF / data-exfiltration: read tools return only the caller's tenant's data (FC-001 tenant scoping). `create_task` is the only write and goes through the normal pipeline + guardrail.
- No tool exposes secrets, `.env`, filesystem paths, or admin-only config.

## Non-goals

- **Not** a push-ingestion surface (that's the HTTP ingestion endpoint).
- **Not** a replacement for the dashboard or chat.
- **Not** multi-tenant federation (one MCP server per Nova instance; tenant scoping via API key).
- **Not** OAuth/provider federation in v1.

## Open questions (resolve before implementation)

1. **Cursor/Claude Code discovery** — do these clients auto-discover MCP servers, or require explicit config? Likely a one-line `mcpServers` config entry pointing at `http://nova:8000/api/v1/mcp` + the API key. Confirm against current MCP client docs.
2. **Streaming tool results** — `search_memory` can return large ranked lists. MCP supports paginated/chunked results; decide whether v1 paginates or returns bounded top-K.
3. **Tool naming** — namespace as `nova__search_memory` (matches Nova's own `mcp__{server}__{tool}` convention) or bare `search_memory`? Bare is friendlier for external clients but risks collision; lean namespaced.
4. **SSE notification channel** — phase 2 could push goal-completion / task-state events to subscribed MCP clients. Defines whether we need the SSE half of Streamable HTTP in v1.

## Effort

S-M (3–5 days): the backing calls all exist; the work is the MCP JSON-RPC framing over HTTP (Nova's `HTTPMCPClient` already implements the client half — the server half is symmetric), the tool-adapter layer, auth wiring, and integration tests with at least one real MCP client (Cursor or the MCP reference CLI).

## Implementation sketch

```
orchestrator/app/mcp_server/
  __init__.py
  server.py          # Streamable HTTP MCP server: JSON-RPC framing, initialize/list_tools/call_tool
  tools.py           # adapter: map MCP tool name → backing call (memory-service / orchestrator router)
  transport.py       # POST /api/v1/mcp handler + optional SSE response stream
  expose.py          # the curated tool list (name, description, input_schema) → MCPTool[]
```

Mounted in `orchestrator/app/main.py` as a router, auth-gated, audit-logged. No new container.
