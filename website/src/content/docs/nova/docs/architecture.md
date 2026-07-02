---
title: "Architecture"
description: "Nova's multi-service Docker Compose architecture, inter-service communication, and tech stack."
---

Nova runs as a multi-service Docker Compose stack. Each service has a single responsibility and communicates over HTTP.

## Services

| Service | Port | Role |
|---------|------|------|
| **orchestrator** | 8000 | Agent lifecycle, task queue, pipeline execution, MCP tool dispatch, DB migrations |
| **llm-gateway** | 8001 | Multi-provider model routing via LiteLLM (Anthropic, OpenAI, Ollama, Groq, Gemini, Cerebras, OpenRouter, GitHub, ChatGPT subscription provider) |
| **memory-service** | 8002 | Embedding + hybrid semantic/keyword retrieval via pgvector |
| **chat-api** | 8080 | WebSocket streaming bridge for external clients |
| **dashboard** | 3000 / 5173 | React admin UI (nginx in production, Vite dev server in development) |
| **postgres** | 5432 | pgvector-enabled PostgreSQL 16 |
| **redis** | 6379 | State, task queue (BRPOP), rate limiting, session memory |
| **recovery** | 8888 | Backup/restore, factory reset, service management, inference backend lifecycle. Depends on postgres and Redis (db 7). |
| **cortex** | 8100 | Autonomous brain: thinking loop, goals, drives, budget tracking |
| **intel-worker** | 8110 | AI ecosystem feed poller (RSS, Reddit JSON, GitHub trending/releases). Health-only HTTP server; pushes to Redis queues. |
| **knowledge-worker** | 8120 | Autonomous personal-knowledge crawler (LLM-guided web crawl, GitHub API). Opt-in via `knowledge` profile. |
| **voice-service** | 8130 | STT/TTS provider proxy (OpenAI Whisper, Deepgram, ElevenLabs). Opt-in via `voice` profile. |
| **ollama** | 11434 | Bundled local model serving (only active when `NOVA_INFERENCE_MODE=hybrid` or `local-only`). |

## Inter-service communication

All communication between services is HTTP. Here's who calls who:

```
dashboard ──proxy──▶ orchestrator  (/api)
          ──proxy──▶ llm-gateway   (/v1)
          ──proxy──▶ recovery      (/recovery-api)
          ──proxy──▶ cortex        (/cortex-api)
          ──proxy──▶ voice-service (/voice-api)

chat-api ──────────▶ orchestrator  (streaming endpoint)

orchestrator ──────▶ llm-gateway   (/complete, /stream, /embed)
             ──────▶ memory-service (/api/v1/memories/*)
             ──────▶ redis          (task queue, state)

recovery ──────────▶ postgres      (backup/restore)
         ──────────▶ Docker API    (service management, inference containers)
         ──────────▶ redis         (system state db 7, reads config db 1)
```

The dashboard depends only on the recovery service at startup. It shows a startup screen while other services come online, so users always have visibility into system state.

## Tech stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python, FastAPI, asyncpg, asyncio |
| **Frontend** | Vite, React, TypeScript, Tailwind CSS, TanStack Query |
| **Database** | PostgreSQL 16 + pgvector |
| **Queue** | Redis (BRPOP task dispatch) |
| **Containers** | Docker Compose with hot reload (watch mode) |
| **Model routing** | LiteLLM (multi-provider abstraction) |

## Shared contracts

The `nova-contracts/` package defines the API contract between services using Pydantic models (chat, LLM, memory, orchestrator). Any service satisfying these models is a drop-in replacement. This is a Pydantic-only package with no runtime dependencies on any service.

## Database

Nova uses two different database access patterns:

| Service | Access layer | Reason |
|---------|-------------|--------|
| **orchestrator** | Raw asyncpg queries | Performance-critical task queue operations, no ORM overhead |
| **memory-service** | SQLAlchemy async | Complex vector queries benefit from ORM expressiveness |

**Migrations** run automatically at orchestrator startup from `orchestrator/app/migrations/*.sql`. These are pure versioned SQL files that run idempotently -- no Alembic.

All tables use UUID primary keys, TIMESTAMPTZ for timestamps, and JSONB for flexible fields.

## Redis DB allocation

Each service uses a dedicated Redis database to avoid key collisions:

| Redis DB | Service |
|----------|---------|
| 0 | memory-service |
| 1 | llm-gateway |
| 2 | orchestrator |
| 3 | chat-api |
| 5 | cortex |
| 6 | intel-worker |
| 7 | recovery |
| 8 | knowledge-worker |
| 9 | voice-service |

## API design

- Raw JSON responses (no `{ data: ... }` wrapper)
- Admin auth: `X-Admin-Secret` header
- API key auth: `Authorization: Bearer sk-nova-<hash>` or `X-API-Key`
- Streaming: Server-Sent Events (SSE) with JSON lines
- Auto-generated API docs at `/docs` on each FastAPI service
