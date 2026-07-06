# 01 — System Overview: Nova AI Platform

> **Audit date:** 2026-07-05 (supersedes the 2026-07-03 audit, which contained
> unverified claims — see `05-dead-code.md` §"Previous audit errata").
> **Method:** every claim in these documents was verified against source code
> and/or the live running stack (14 containers, healthy at audit time).
> **Branch:** `feature/okf-memory-actions` @ `cee5bc1`, working tree clean.

---

## What Nova Is

Nova is a **self-hosted, self-directed autonomous AI platform** with two co-equal
product pillars:

1. **Autonomous brain** — a background thinking loop (Cortex) that pursues
   user-defined goals: triages them, scopes, specs, waits for human review,
   builds via a 5-stage agent pipeline, and verifies the result.
2. **Memory-backed personal assistant** — a chat agent with durable, human-editable
   memory stored as a folder of markdown files (OKF frontmatter + BM25 retrieval),
   fed by ingestion workers (chat exchanges, RSS/Reddit feeds, web crawls,
   desktop screen capture).

Deployment target is a single machine running Docker Compose. There are **no
users yet** (pre-release); breaking changes are acceptable and no migration
compatibility is required.

**Application type:** multi-service HTTP platform — FastAPI backends (Python
3.12, async throughout), a React SPA admin dashboard, PostgreSQL 16 + Redis 7
infrastructure, and pluggable LLM inference (bundled containers, external local
servers, or cloud APIs).

---

## Service Topology (verified against docker-compose.yml + live stack)

### Always-on core (12 containers)

| Service | Port | Size | Role |
|---|---|---|---|
| **orchestrator** | 8000 | 128 py files / 32,015 loc | The hub: chat agent runtime, 5-stage pipeline executor, ~70 agent tools, task queue, MCP client, auth/RBAC, secrets, feature flags, DB migrations, 16 API routers |
| **llm-gateway** | 8001 | 31 / 5,594 | Multi-provider LLM routing (13 provider impls), rate limiting, response cache, model discovery, Wake-on-LAN |
| **memory-service** | 8002 | 16 / 2,299 | Neutral `/api/v1/memory/*` API over a pluggable `MemoryBackend`; only built-in backend is OKF markdown (files + BM25, **no database**) |
| **chat-api** | 8080 | 6 / 995 | WebSocket bridge: WS clients ↔ orchestrator SSE streaming |
| **cortex** | 8100 | 36 / 5,856 | Autonomous brain: BRPOP-driven thinking loop, 7 drives, goal maturation state machine, budget tracking |
| **recovery** | 8888 | 20 / 3,117 | Backup/restore, factory reset, service + bundled-inference lifecycle. Depends only on postgres/redis — survives platform crashes |
| **intel-worker** | 8110 | 12 / 576 | RSS/Reddit/GitHub-trending feed poller → orchestrator API + memory ingestion queue |
| **screenpipe-bridge** | 8140 | 27 / 1,799 | Subscribes to a user-installed screenpipe daemon; aggregates focus sessions; privacy denylist; → memory ingestion queue |
| **dashboard** | 3000 | 188 ts files / 38,306 loc | React admin UI: 32 pages, 33 settings sections, 38 shared UI components |
| **docker-socket-proxy** | — | image | SEC-006b: allowlisted Docker API (containers list/inspect/logs/restart only) for recovery's SDK path |
| **postgres** | 5432 | pgvector/pg16 | 66 live tables (62 from migrations + legacy orphans, see 03) |
| **redis** | 6379 | redis:7 | 12 logical DBs: queues, config, rate limits, pubsub |

### Optional profiles

| Profile | Service (port) | Status on audited host |
|---|---|---|
| `knowledge` | knowledge-worker (8120) — LLM-guided personal web crawler | not running |
| `browser` | browser-worker (8150) — Playwright sessions, persistent per-domain profiles | **running** |
| `voice` | voice-service (8130) — STT/TTS proxy (OpenAI only; Deepgram/ElevenLabs were removed) | **running** |
| `inference-ollama/-vllm/-sglang/-llamacpp` | bundled inference containers, started by recovery or `COMPOSE_PROFILES`; GPU via `docker-compose.gpu.yml` overlay | not running (external host Ollama in use) |
| `secrets` | vaultwarden (8222) | not running |
| `editor-vscode` / `editor-neovim` | embedded editors for the dashboard Editor page | neovim in `.env` profile list |
| `website` | Astro/Starlight marketing+docs site (4000) | not running |
| `cloudflare-tunnel`, `tailscale` | remote-access sidecars | not running |

⚠️ The audited host's `.env` has `COMPOSE_PROFILES=bridges,editor-neovim,search,voice` —
`bridges` and `search` match **no profile in the compose file** (dead values from
removed services), and `browser` is missing even though browser-worker is running
(started out-of-band). See `05-dead-code.md`.

---

## Component Diagram

```
                        ┌──────────────────────────┐
   Browser ───────────► │  dashboard :3000 (nginx)  │
                        │  proxies: /api → orch     │
                        │  /v1 → gateway, /recovery-api → recovery,
                        │  /cortex-api → cortex, /voice-api → voice
                        └────────────┬─────────────┘
   WS clients ──► chat-api :8080 ────┤ (HTTP/SSE)
   IDEs (OpenAI-compat) ─────────────┤
                                     ▼
        ┌───────────────────────────────────────────────────┐
        │                orchestrator :8000                  │
        │  chat runner │ pipeline executor │ ~70 tools │ MCP │
        │  auth/RBAC │ secrets │ flags │ 89 SQL migrations   │
        └───┬────────────┬─────────────┬────────────────┬───┘
            │            │             │                │
            ▼            ▼             │                ▼
   llm-gateway :8001  memory-service :8002        browser-worker :8150
   13 providers       OKF markdown backend         (Playwright)
      │                   │
      │              $NOVA_WORKSPACE/memory/*.md   ◄── also bind-mounted into
      ▼                   ▲                            orchestrator (file tools)
   local: bundled         │ BRPOP memory:ingestion:queue (redis db0)
   containers / host      │
   Ollama / LM Studio     ├── chat exchanges (orchestrator)
   cloud: Anthropic,      ├── intel-worker :8110  (RSS/Reddit/GitHub)
   OpenAI, Groq, Gemini,  ├── knowledge-worker :8120 (crawler, optional)
   Cerebras, OpenRouter,  ├── screenpipe-bridge :8140 (desktop capture)
   GitHub, ChatGPT-sub    └── cortex reflections
                                     ▲
        ┌────────────────────────────┴──────────────────────┐
        │                  cortex :8100                      │
        │  thinking loop → drives → plan → act → reflect     │
        │  goal maturation: triage→scope→spec→review→build→verify
        │  calls: orchestrator (tasks/goals), gateway (LLM), │
        │         memory-service (perceive/reflect)          │
        └────────────────────────────────────────────────────┘

   recovery :8888 ──► docker-socket-proxy ──► docker daemon (SDK: allowlisted)
        │        └──► /var/run/docker.sock (compose CLI: full, by design)
        └──► postgres (pg_dump backups), .env whitelist editor,
             bundled-inference lifecycle, factory reset

   postgres :5432 ◄── orchestrator (asyncpg, owns migrations), cortex, recovery
   redis :6379    ◄── all services (12 logical DBs, see 03-data-model)
```

**Startup order:** postgres/redis → llm-gateway, memory-service → orchestrator
(runs migrations, seeds tenant/admin/secrets/flags) → chat-api, workers.
Dashboard depends only on recovery, so the UI serves a startup screen while the
rest of the stack boots.

---

## Primary Data Flows

### 1. Chat turn (assistant pillar)

```
client → dashboard /api or chat-api WS
  → orchestrator run_agent_turn_streaming()        (agents/runner.py:226)
      1. memory context: POST memory-service /api/v1/memory/context
         (or agent-driven via memory tools when memory_retrieval_mode=tools)
      2. build prompt: system + self-knowledge + sandbox ctx + memory + history
      3. POST llm-gateway /stream  → provider (SSE: thinking/progress/tokens)
      4. tool loop (_run_tool_loop, runner.py:1067): memory / web / code / git /
         github / browser / config / intel / diagnosis tools, max N rounds
      5. stream sources (memory files recalled + web pages fetched) to client
      6. fire-and-forget: exchange digest → redis memory:ingestion:queue
         → memory-service → journal/YYYY-MM-DD.md
```

### 2. Pipeline task (execution engine)

```
POST /api/v1/pipeline/tasks (dashboard, cortex, or API key)
  → INSERT tasks row (status=queued) → LPUSH nova:queue:tasks (redis db2)
  → queue_worker BRPOP → pipeline/executor.py (2,014 loc)
      stages (pipeline/agents/): context → task → guardrail → code_review
        → critique → decision → post_pipeline
      each stage: heartbeat (30s TTL) + checkpoint JSONB (resume after crash)
      state machine: CAS transitions (pipeline/state_machine.py)
      reaper: re-queues tasks with stale heartbeats (150s)
  → status=complete/failed → pubsub nova:notifications → SSE to dashboard
```

### 3. Cortex autonomous cycle (brain pillar)

```
loop.py: BRPOP cortex stimulus queue (timeout = adaptive 30s…1800s)
  gate: orchestrator config features.brain_enabled (default OFF)
  cycle.py run_cycle():
    PERCEIVE  budget tier, user journal replies, due goal schedules,
              background task results, memory context
    EVALUATE  7 drives assess() → highest urgency wins
              (serve, improve, maintain, learn, reflect, quality, ci_triage)
    PLAN      LLM plan for the selected goal (approach-dedup: blocked
              approaches trigger a re-plan)
    ACT       serve: maturation dispatch —
                triaging  → maintain drive classifies complexity (LLM)
                scoping   → run_scoping()   → speccing
                speccing  → run_speccing()  → review (human gate, dashboard)
                building  → run_building()  → dispatch pipeline task(s)
                waiting   → children/tasks done? → verifying
                verifying → run_verifying() → done / re-plan
              simple goals: dispatch one pipeline task directly
    REFLECT   write reflection → cortex_reflections + memory ingestion
  CI fast-path: workflow-failure stimuli dispatch ci_triage directly.
```

### 4. Memory ingestion & retrieval (memory pillar)

```
producers (chat, intel, knowledge, screenpipe, cortex)
  → LPUSH memory:ingestion:queue (redis db0)
  → memory-service ingestion loop → active backend .write()
      OKF backend: explicit okf metadata → topics|people|projects|preferences/<slug>.md
                   everything else      → journal/YYYY-MM-DD.md (digest append)
retrieval: BM25 over .nova/index.json (self-heals on file mtime drift;
  zero embeddings, zero LLM calls); root index.md always injected;
  mark_used/feedback adjust a per-file score accumulator.
curation: seeded cron goal "Nightly memory curation" (03:00) distills journals
  into concept files; a 45-day journal-retention backstop archives old journals
  regardless of whether the brain is enabled.
```

---

## Configuration Layers (precedence, lowest → highest)

1. **In-code defaults** (`pydantic_settings` per service)
2. **`.env`** — infra-only knobs + first-boot secret bootstrap (mirrored into
   `platform_secrets` once, then rotatable via UI)
3. **`platform_config` table** (authoritative) → synced to **Redis
   `nova:config:*`** (db1) at startup; UI writes go DB-first
4. **Feature flags** (`feature_flags` table + per-service in-process cache,
   pubsub invalidation, per-service partition-fallback file
   `data/flag-cache/<service>.json`); env override `NOVA_FLAG_<KEY>` is
   boot-time only
5. Test-scope `flag_override()` context manager

**Known footgun (by design docs, confirmed live):** stale Redis config values
survive restarts; debugging inference issues starts with
`redis-cli -n 1 MGET nova:config:inference.{backend,state,url}`.

---

## External Dependencies

| Dependency | Used by | Notes |
|---|---|---|
| PostgreSQL 16 + pgvector | orchestrator, cortex, recovery | bind-mount `./data/postgres`; pgvector extension enabled but **no live code currently uses vector columns** (legacy engram tables only) |
| Redis 7 | all services | bind-mount `./data/redis`; allkeys-lru 512 MB |
| Docker daemon | recovery only | via socket-proxy (SDK) + raw socket (compose CLI) |
| Cloud LLM APIs | llm-gateway | Anthropic, OpenAI, Groq, Gemini (+ADC), Cerebras, OpenRouter, GitHub Models, ChatGPT subscription (codex token) |
| Local inference | llm-gateway | bundled ollama/vllm/sglang/llamacpp containers OR external host servers (Ollama, LM Studio, any OpenAI-compatible) |
| screenpipe daemon | screenpipe-bridge | user-installed, workstation-side, WS + HTTP-poll fallback |
| GitHub API | orchestrator (capabilities, webhooks, self-mod), intel-worker | PATs stored AES-256-GCM encrypted |

---

## Runtime Snapshot (audited host, 2026-07-05)

- 14 containers up 2 days, all healthy.
- Routing: `local-first`; inference backend `ollama` (state `ready`), external
  host Ollama at `host.docker.internal:11434`; default chat model `qwen2.5:7b`.
- Memory: 5 concept files, 0 links, last ingestion 2026-07-06T00:09Z — a
  freshly reset instance.
- DB: 1 task, 1 goal (the seeded memory-curation goal), 403 usage events,
  17 friction entries.
- `REQUIRE_AUTH=true`, `SELFMOD` disabled, brain toggle default off.

---

## Assumptions & Flagged Uncertainties

- **A1:** `main` is the PR target; this audit describes `feature/okf-memory-actions`,
  which is substantially ahead of `main` (memory rewrite, browser-worker,
  bundled-inference return). Docs assume this branch is the intended direction
  (confirmed by owner 2026-07-05).
- **A2:** Multi-tenancy is scaffolding (tenants table, tenant_id columns,
  FC-001/FC-002 isolation tests) but the product is operated single-tenant;
  nothing provisions a second tenant.
- **A3:** pgvector is retained for future backends; the OKF backend does not
  use it. If no embedding backend is planned, the pgvector image requirement
  could be dropped (kept: cheap, and keeps the door open).
- **U1:** `install` (36 KB wizard) and `scripts/bootstrap.sh` were rewritten
  for the bundled-inference return (2026-07-03) but have not been end-to-end
  tested on a clean machine within this audit's scope. Treat first-boot UX as
  unverified.
- **U2:** Claude-subscription OAuth provider was removed from llm-gateway;
  TODOS.md still references it (stale).
