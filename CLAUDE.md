# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

**IMPORTANT:** This is Nova v2 — a ground-up rewrite completed May 2026. Many directories
in this repo are dead v1 code that has not been deleted yet. Do not confuse them with the
active v2 stack. See "Dead Code" section below.

---

## What Is Nova

Nova is a self-directed autonomous AI platform. You define a goal; Nova breaks it into
tasks, executes them with tool use, and runs autonomously between conversations.
It runs as a Docker Compose stack of 7 core services.

---

## Active v2 Services

| Service | Port | Purpose |
|---|---|---|
| **agent-core** | 8000 | Task execution, LLM coordination, secrets, schedules, MCP, conversations |
| **llm-gateway** | 8001 | Multi-provider LLM routing (Ollama, OpenAI, Gemini, etc.) |
| **memory-service** | 8002 | Simple `memories` table + pgvector semantic search |
| **voice-gateway** | 8003 | STT/TTS proxy — profile `voice`, optional |
| **chat-surface** | 8004 | WebSocket bridge: browser ↔ agent-core |
| **recovery** | 8888 | Backup/restore, Docker container management |
| **dashboard** | 3000 | React PWA (nginx prod / Vite :5173 dev) |
| **postgres** | 5432 | pgvector-enabled PostgreSQL 16 |
| **redis** | 6379 | State, pub/sub, task queue |
| **docker-socket-proxy** | 2375 | Scoped Docker API proxy (containers/exec/images only) |

**Optional inference profiles** (started by `./install` based on hardware):

| Profile | Port | Engine |
|---|---|---|
| `local-ollama` | 11434 | Ollama (bundled) |
| `local-llamacpp` | 11435 | llama.cpp server |
| `local-vllm` | 11436 | vLLM |
| `local-sglang` | 11437 | SGLang |

Default config uses host Ollama (Windows native, WSL2 dev environment) rather than
the `local-ollama` profile. `LOCAL_INFERENCE_URL` points to the Windows host IP.

---

## Inter-Service Communication

- **Dashboard → agent-core:** nginx proxies `/api/` → `agent-core:8000`
- **Dashboard → voice-gateway:** nginx proxies `/voice-api/` → `voice-gateway:8003`
- **Dashboard → chat-surface:** nginx proxies `/ws` → `chat-surface:8004` (WebSocket)
- **agent-core → llm-gateway:** `http://llm-gateway:8001`
- **agent-core → memory-service:** `http://memory-service:8002`
- **chat-surface → agent-core:** `http://agent-core:8000`

**Dev proxy** (Vite, port 5173): `/api` → 8000, `/v1` → 8001, `/ws` → 8004,
`/voice-api` → 8003, `/recovery-api` → 8888.

**Production nginx gaps (known, not yet fixed):** nginx does not proxy `/v1/` or
`/recovery-api/` in production — only `/api/`, `/voice-api/`, and `/ws/`.

---

## API Reference

### agent-core (8000)

```
GET/POST /api/v1/conversations
DELETE   /api/v1/conversations/{conv_id}
POST     /api/v1/tasks
GET      /api/v1/tasks/{task_id}
GET      /api/v1/tasks/{task_id}/events      # SSE stream
POST     /api/v1/tasks/{task_id}/message
GET      /api/v1/tasks/{task_id}/messages
POST     /api/v1/approvals/{approval_id}/grant
POST     /api/v1/approvals/{approval_id}/deny
GET/POST /api/v1/secrets
POST     /api/v1/secrets/resolve             # plaintext for inter-service use
DELETE   /api/v1/secrets/{name}
GET      /api/v1/llm/providers
GET/PUT  /api/v1/llm/config
GET      /api/v1/mcp/servers
POST     /api/v1/mcp/servers/{id}/discover
POST     /api/v1/mcp/servers/{id}/restart
GET      /api/v1/schedules
POST     /api/v1/webhooks/{schedule_id}
GET/PUT  /api/v1/identity
GET      /api/v1/memories/stats          # proxies memory-service for the dashboard
GET      /api/v1/memories/profile
POST     /api/v1/memories/search
GET/DELETE /api/v1/memories/{id}
```

Auth: `X-Admin-Secret` header (or `Authorization: Bearer sk-nova-<hash>` for API keys).

### llm-gateway (8001)

```
POST /complete     # single completion
POST /stream       # streaming SSE completion
POST /embed        # embeddings
GET  /providers    # provider availability + models
GET  /config       # routing strategy
```

### memory-service (8002)

```
POST  /memories              # store a memory; extract:true queues LLM distillation (202)
GET   /memories              # list
POST  /memories/search       # salience-ranked semantic + keyword search
GET   /memories/profile      # high-importance facts/preferences (the user profile block)
GET   /memories/stats        # counts, embedding coverage
GET   /memories/{id}
PATCH /memories/{id}/used    # increment used_count, update last_used
```

Memory is a flat `memories` table with pgvector embeddings. No graph, no engrams,
no spreading activation. Search is two-stage: vector-index candidates re-ranked by
salience (0.60 similarity + 0.15 recency + 0.15 importance + 0.10 reinforcement);
keyword fallback (`tsvector`) gets the same blend. Chat exchanges are distilled by
an extraction worker (`EXTRACTION_MODEL`, default `auto`) into structured
fact/preference/event/insight rows; LLM failure falls back to verbatim storage.
Nothing is auto-deleted — old irrelevant memories rank lower, they don't vanish.

### voice-gateway (8003) — profile: `voice`

```
POST /stt/stream    # audio bytes → SSE transcript
POST /tts/stream    # text → streaming binary Opus (4-byte big-endian seq prefix per chunk)
GET  /providers     # STT/TTS provider availability
```

### chat-surface (8004)

WebSocket only at `/ws`. No REST endpoints.
Protocol: `chat-surface` message types (defined in `nova-contracts/nova_contracts/chat.py`).

---

## Key Configuration (.env)

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | DB password |
| `ADMIN_SECRET` | `X-Admin-Secret` header value |
| `CREDENTIAL_MASTER_KEY` | AES-256-GCM master key for secrets encryption |
| `NOVA_INFERENCE_BACKEND` | Active inference backend (e.g. `ollama-host`) |
| `LOCAL_INFERENCE_URL` | URL for local LLM (e.g. `http://host.docker.internal:11434`) |
| `LOCAL_COMPLETION_MODEL` | Default local completion model (e.g. `llama3.2`) |
| `LOCAL_EMBED_MODEL` | Embedding model (e.g. `nomic-embed-text`) |
| `LLM_ROUTING_STRATEGY` | `local-first`, `local-only`, `cloud-first`, `cloud-only` |
| `EXTRACTION_MODEL` | Memory-extraction model (default `auto`; pin a small model like `qwen2.5:1.5b` on CPU-only boxes) |
| `COMPOSE_PROFILES` | Comma-separated active profiles (e.g. `voice`) |
| `LOG_LEVEL` | `INFO` (prod) / `DEBUG` (dev) |
| `NOVA_WORKSPACE` | Host path agent-core can access as its workspace |

---

## Build & Run

```bash
./install          # First-time setup wizard
./start            # Production boot (build + up + wait for health)

make dev           # Dev with hot reload (docker compose up --build --watch)
make logs          # Tail all service logs
make ps            # Container status

make test          # Integration tests (~2 min, requires services running)
make test-quick    # Health endpoints only (~0.4s)

make backup        # DB backup to ./backups/
make prune         # Remove containers + images (preserves volumes)
```

**Dashboard dev server:** port 5173 via Vite.
**DB migrations:** auto-run at agent-core startup from `agent-core/app/migrations/*.sql`.

---

## Code Conventions

**Python (all backend services):**
- Async/await throughout (FastAPI + asyncpg or SQLAlchemy async)
- Config via `pydantic_settings.BaseSettings` reading from `.env`
- agent-core: raw asyncpg queries (no ORM)
- memory-service: SQLAlchemy async
- Fault-tolerant: try/except + `logger.warning` — never crash on missing optional config
- Log levels: ERROR=unrecoverable, WARNING=recoverable, INFO=state changes, DEBUG=flow

**React/TypeScript (dashboard):**
- Functional components only, TanStack Query for server state
- Tailwind CSS; Lucide React icons
- API calls via `apiFetch<T>()` in `src/api.ts`; admin secret in localStorage
- Auth header: `X-Admin-Secret`

**API design:**
- Raw JSON responses (no `{ data: ... }` wrapper)
- Streaming: SSE with JSON lines (agent-core tasks) or raw binary (voice TTS)

---

## Dead Code — Do Not Use

The v1 service directories (`orchestrator/`, `chat-api/`, `chat-bridge/`, `cortex/`,
`intel-worker/`, `knowledge-worker/`, `voice-service/`, `screenpipe-bridge/`,
`recovery-service/`, `nova-worker-common/`, the `baseline-*` benchmark dirs, and the
v1 dashboard Brain/Sidebar/MobileNav components) were **deleted** in commit `a328813`
(2026-05-20). If you see references to them — in docs, CI, or old plans — they are
stale; do not resurrect them from git history. v1 replacements: `orchestrator/` →
`agent-core/`, `chat-api/` → `chat-surface/`, `voice-service/` → `voice-gateway/`,
`recovery-service/` → `recovery/`.

`nova-contracts/` is the shared contracts package: services import the shared models
through the package root (re-exports from `models.py`), and `chat.py` documents the
chat-surface WebSocket protocol. Its v1 modules (`engram.py`, `orchestrator.py`) and
the `memory-service/app/engram/` package that consumed them were deleted in June 2026,
along with the v1 engram test suite that lived in `memory-service/tests/`.

---

## Known Issues (as of 2026-05-20)

- **Dead letter queue:** 285 stale entries from pre-v2. Not growing. Flush with:
  `docker compose exec redis redis-cli -n 2 DEL nova:queue:dead_letter`

---

## Regression Gate — Non-Negotiable

### Before touching any code

Run `make test-v2` and record which tests pass. This is your baseline. If tests are
already failing before you start, note them — you are not responsible for pre-existing
failures, but you must not add new ones.

### After any backend change (agent-core, llm-gateway, any service)

Run `make test-v2` again. Every test that passed before must still pass. If a new
failure appears, fix it before continuing. Do not ship a change that breaks a passing test.

### After any frontend change

1. **Rebuild and redeploy** the affected service(s).
2. **Open the app with Playwright** (`browser_navigate` to `http://localhost:3000`).
3. **Exercise the specific behavior** that was changed — not just "the build passes."
4. **Confirm the observable outcome**: element visible, network request returns expected
   response, state changes correctly, etc.
5. Only then report done.

### Tests to run: `make test-v2`

This runs only the v2-service test files. `make test` runs the full suite including
many v1 tests that will always fail — do not use it to judge regressions.

```
test_agent_core.py      — task execution, approvals, auth, LLM proxy
test_llm_gateway.py     — completion, streaming, embedding, providers
test_llm_models_proxy.py — all Ollama models visible (not just one default)
test_model_discovery.py — /models/discover full catalog
test_secrets.py         — secrets CRUD
test_voice_gateway.py   — STT/TTS providers
test_health.py          — service health endpoints
test_memory.py          — memory store and search
test_schedules.py       — schedule CRUD, poll + webhook firing, chat-thread output (slowest file — firing tests wait out the 30s poll cycle)
test_proactivity.py     — capability gate, control API, pulse dispatch guards (slow — drives real poll cycles)
test_model_recommendations.py — manifest, hardware fit gating, pull lifecycle (downloads a ~46MB model)
test_wol.py             — Wake-on-LAN: magic packet capture on udp/9 (skips without root), helper auth
```

"The code looks correct" is not a test result. A green `make test-v2` + Playwright
evidence is a test result. Nothing else counts.

---

## Design System

Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

---

## Skill Routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action.

Key routing rules:
- Bugs, errors, "why is this broken" → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
