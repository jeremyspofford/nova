# Nova Rebuild - Brain Home Screen + Multi-Agent Chat

A from-scratch rebuild of Nova focusing on one working feature: brain-as-home-screen with persistent agent-based chat.

## Quick Start

```bash
cp .env.example .env
docker compose up -d
```

Visit http://localhost:5173 for the UI (Brain + Chat panel)

Backend runs at http://localhost:8000 with health check at `/health`

## Architecture

- **Frontend**: React + Vite + Tailwind (chat + brain visualization)
- **Backend**: FastAPI + asyncpg (agent orchestration, memory, LLM routing)
- **Memory**: OKF markdown files + BM25 index (low-cost retrieval)
- **Agents**: Simple DB-backed agents with tool dispatch
- **LLM**: OpenRouter (cloud) + Ollama (local)

## Phases (Implementation Status)

- ✅ **Phase 0**: Docker scaffold + health checks
- ✅ **Phase 1**: Chat streaming + persistent conversation  
- ✅ **Phase 2**: Memory (OKF markdown + BM25 retrieval)
- ✅ **Phase 3**: Agent index + dispatch (5 seeded meta-agents)
- 🔄 **Phase 4**: Tool system (schema in place, executor TBD)
- 🔄 **Phase 5**: Skills (markdown pattern ready, retrieval wired)
- 📋 **Phase 6**: Multi-theme support (architectural seam ready)

## Key Features Working

1. **Persistent chat** — one continuous session, survives page refresh
2. **Agent index** — `/api/v1/agents` lists all available agents
3. **Agent dispatch** — main agent can delegate to specialists via `dispatch_to_agent` tool
4. **Memory context** — chat automatically retrieves relevant memories  
5. **Tool registry** — extensible tool dispatch system (7 builtin tools)
6. **Meta-agents** — `main`, `agent-manager`, `agent-creator`, `skill-manager`, `tool-creator`

## API Endpoints

```
POST   /api/v1/chat/stream              Chat streaming (SSE)
GET    /api/v1/conversations/active     Active conversation
GET    /api/v1/conversations/{id}/messages  Message history
GET    /api/v1/agents                   List agents
GET    /api/v1/memory/stats             Memory stats
GET    /api/v1/memory/graph             Memory graph for visualization
GET    /health                          Health check
```

## Configuration

`.env` file controls:
- `OPENROUTER_API_KEY` — Cloud LLM provider
- `OLLAMA_BASE_URL` — Local inference (default: `http://host.docker.internal:11434`)
- `DATABASE_URL` — Postgres connection
- `OKF_MEMORY_DIR` — Memory storage directory

## Known Limitations (Phase Notes)

- **Phase 1**: Requires OpenRouter API key or Ollama running on host for actual chat
- **Phase 4**: Tools table exists but full http_call executor deferred
- **Phase 5**: Skills-as-markdown ready but skill-retrieval prompt injection still TBD
- **Phase 6**: Single brain renderer (2D force graph); theme-swap seam exists

## Development

Backend hot-reloads on file changes. Frontend dev server at 5173.

```bash
# Rebuild after code changes
docker compose build backend

# Watch logs
docker compose logs -f backend
```

## Next Steps

1. **Configure LLM**: Set `OPENROUTER_API_KEY` in `.env` (or run Ollama locally)
2. **Test chat**: Send a message in the UI, watch it route through the main agent
3. **Try dispatch**: Ask "create an agent that summarizes news" — should delegate to `agent-creator`
4. **Extend**: Add new agents by creating them via `agent-creator`, or new tools via builtin registry

## Implementation Notes

- No auth/users in v1 (single-operator localhost)
- No RBAC, no multi-tenancy (deferred to future phases)
- Agent dispatch depth capped at 1 (prevent infinite loops)
- Memory uses in-process BM25 index (could be extracted to service later)
- LLM routing is simple prefix-based (openrouter: vs ollama:)

Built for *simplicity* and *working end-to-end* — not for production or scale, yet.
