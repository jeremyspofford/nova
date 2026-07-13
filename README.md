# Nova — Brain Home Screen + Multi-Agent Chat

A small, working AI agent platform: the main screen is a live memory-graph
("brain") with one continuous chat session overlaid. Chat talks to a **main
agent** that answers directly or dispatches to specialist agents from a
registry — including meta-agents that create new agents, tools, and skills at
runtime.

## Quick start

```bash
cp .env.example .env       # put a real OPENROUTER_API_KEY in .env
docker compose up -d
```

- UI: http://localhost:5173 (brain graph + chat)
- API: http://localhost:8000 (`/health`, `/docs`)

Without an OpenRouter key, models fall back to local Ollama
(`OLLAMA_BASE_URL`, default `host.docker.internal:11434`).

## What works (all live-verified)

| Capability | How |
|---|---|
| Streamed chat, one continuous session | SSE from `POST /api/v1/chat/stream`; history in Postgres, survives restarts |
| Agent index + dispatch | `agents` table; main agent uses `list_agents` / `dispatch_to_agent`; sub-agents run with their own tools (depth capped at 1) |
| **Agent creation at runtime** | ask for a capability → main dispatches to `agent-creator` → `manage_agents` inserts a row → usable immediately |
| **Tool creation at runtime, no restart** | `tool-creator` writes declarative `http_call` specs to the `tools` table; a generic executor runs them against an operator host-allowlist (checked at create AND execute) |
| **Skills** | `skill-manager` writes `skills/*.md`; BM25 retrieval injects applicable skills into agent prompts; behavior demonstrably follows them |
| Memory | OKF-style markdown files + in-process BM25 (no embeddings); topics/journals/skills; recall survives full `docker compose down && up --build` |
| Brain view | d3-force canvas of the real memory graph (teal topics, amber skills, dim journals), refreshes every 20s; renderers live behind a theme registry (`frontend/src/brain/theme.ts`) |

Seeded system agents (`is_system`, disable-able but never deletable): `main`,
`agent-manager`, `agent-creator`, `skill-manager`, `tool-creator`.

## Architecture

3 containers: **postgres** (16-alpine), **backend** (FastAPI + asyncpg),
**frontend** (Vite/React/Tailwind). Memory is an in-process library over
`./data/memory/*.md` (git-friendly, human-readable). LLM routing is a
prefix on the agent's model string: `openrouter:<model>` or `ollama:<model>`.

```
backend/app/
├── llm/            openai_compat.py (one streaming client), router.py
├── agents/         registry.py (CRUD), runner.py (bounded tool loop + inline dispatch)
├── tools/          registry.py (builtins + DB tools, one dispatch point),
│                   builtin.py, http_executor.py (allowlisted, capped)
├── memory/         store.py (OKF markdown), index.py (BM25), memory.py (facade)
├── conversations.py, router_chat.py (SSE), migrations/*.sql (auto-run)
frontend/src/
├── pages/Brain.tsx  brain/graph2d.ts  brain/theme.ts  chat/ChatPanel.tsx  api.ts
```

## SSE contract

```
data: {"meta": {"conversation_id": ..., "model": ...}}
data: {"t": "text delta"}
data: {"activity": {"kind": "tool_start|tool_result|dispatch", "name": ..., "agent": ..., "detail": ...}}
data: {"error": "..."}
data: [DONE]
```

## Deliberate v1 boundaries

- Single operator, localhost — no auth/users/tenancy
- Dispatch depth capped at 1 (no recursive delegation)
- Tool creation limited to allowlisted `http_call` specs — no code generation/execution
- No guardrail layer; agent-created prompts/tools are trusted-operator content
- One brain theme (2D force graph); more register via `THEMES` without touching Brain.tsx
