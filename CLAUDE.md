# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Nova

Nova is a self-directed autonomous AI platform. Users define a goal; Nova breaks it into subtasks, executes them through a coordinated agent pipeline, and re-plans as needed. It runs as a 9-service Docker Compose stack.

## Architecture

**Services and ports:**

- **orchestrator** (8000) — Agent lifecycle, task queue, pipeline execution, MCP tool dispatch, DB migrations (FastAPI + asyncpg)
- **llm-gateway** (8001) — Multi-provider model routing via LiteLLM: Anthropic, OpenAI, Ollama, Groq, Gemini, Cerebras, OpenRouter, GitHub, Claude/ChatGPT subscription providers (FastAPI)
- **memory-service** (8002) — Memory behind a neutral `/api/v1/memory/*` API. Storage: **OKF markdown bundle** (a folder of markdown files with OKF frontmatter + BM25 retrieval; no Postgres) (FastAPI)
- **chat-api** (8080) — WebSocket streaming bridge for external clients (FastAPI)
- **dashboard** (3000/5173) — React admin UI (Vite dev / nginx prod)
- **postgres** (5432) — pgvector-enabled PostgreSQL 16 (data bind-mounted to `./data/postgres/`)
- **recovery** (8888) — Backup/restore, factory reset, service management (FastAPI + asyncpg + Docker SDK). Only depends on postgres — stays alive when other services crash.
- **cortex** (8100) — Autonomous brain: thinking loop, goals, drives, budget tracking (FastAPI + asyncpg)
- **intel-worker** (8110) — AI ecosystem feed poller: RSS, Reddit JSON, page change detection, GitHub trending/releases. Pushes content via orchestrator HTTP API, queues to memory ingestion (FastAPI, health-only server)
- **knowledge-worker** (8120) — Autonomous personal knowledge crawler: LLM-guided web crawling, GitHub API extraction, encrypted credential storage (FastAPI). Optional, start with `--profile knowledge`.
- **voice-service** (8130) — STT/TTS provider proxy: OpenAI Whisper, OpenAI TTS (FastAPI). Optional, start with `--profile voice`.
- **browser-worker** (8150) — Playwright browser automation: navigate, snapshot (numbered accessibility-tree elements), act (click/type/select), submit forms, sign up for accounts. Persistent per-domain profiles so logins survive restarts. Optional, start with `--profile browser` (Playwright image ~1.5GB).
- **ntfy** (8290) — Bundled self-hosted push-notification server. The orchestrator (`app/notifier.py`) publishes approvals, checkpoints, task failures/review/clarification, goal-linked completions, and agent-sent messages (`send_push` tool in `app/tools/notify_tools.py`, event `agent_push`, in-process storm brake 10/hour) to a seeded private topic (`notify.ntfy_topic` — the topic name is the subscription secret). A seeded **"Morning briefing"** cron goal (11:00 UTC, migration 095) composes a daily journal+intel digest and delivers it via `send_push`; cortex's scheduler self-heals NULL `schedule_next_at` so migration-seeded cron goals actually fire. When `notify.action_base_url` is set, approval/checkpoint pushes carry signed one-shot Approve/Deny buttons that POST to `/api/v1/notify/actions/decide` (HMAC per approval+decision+expiry, key `notify.action_key`, minted in `app/notify_actions.py` — no admin secret ever reaches the phone). Loopback-bound by default; `NTFY_BIND=0.0.0.0:` or Tailscale for phones. Delivery is best-effort and never blocks consent or the pipeline. Every publish attempt is recorded as a delivery receipt (`notify_log`, migration 096; `GET /api/v1/notify/log`) and Settings → Notifications shows the live ntfy subscriber count (`NTFY_ENABLE_METRICS`) — "accepted by ntfy" ≠ "a device received it". The same rows power the dashboard **Inbox** (`/inbox`, sidebar item with unread badge; migration 097 adds `message` + `read_at`; `GET /api/v1/notify/inbox`, `POST /api/v1/notify/inbox/read`) — operator messages are readable in Nova with no push client at all.
- **redis** (6379) — State, task queue (BRPOP), rate limiting, session memory (data bind-mounted to `./data/redis/`)
- **grafana** (3001) — Observability dashboards over Nova's Postgres (Nova Autonomy, Nova Operations), provisioned read-only from `observability/grafana/`. Stateless. Optional: start with `make observability` (extracts the JWT signing key to a gitignored JWKS first). Embedded in the dashboard at `/monitoring` via the nginx `/grafana/` proxy with **Nova-account SSO** (Grafana validates Nova JWTs via `GF_AUTH_JWT_*`; owners/admins → Grafana Admin). Native admin/`GRAFANA_ADMIN_PASSWORD` login (defaults to `NOVA_ADMIN_SECRET`) is break-glass.

**Inter-service communication:** All HTTP. Orchestrator calls llm-gateway (`/complete`, `/stream`, `/embed`) and memory-service (`/api/v1/memory/*`). Dashboard proxies to orchestrator (`/api`), llm-gateway (`/v1`), recovery (`/recovery-api`), cortex (`/cortex-api`), and voice-service (`/voice-api`). Chat-api forwards to orchestrator's streaming endpoint. Cortex calls orchestrator (task dispatch, goal management), llm-gateway (planning, evaluation), and memory-service (read/write knowledge). Intel-worker calls orchestrator (`/api/v1/intel/feeds`, `/api/v1/intel/content`, `/api/v1/intel/feeds/{id}/status`) and pushes to Redis queues (db0 memory ingestion, db6 intel new-items). Knowledge-worker calls orchestrator (`/api/v1/knowledge/sources`, `/api/v1/knowledge/crawl-log`), llm-gateway (`/complete` for relevance scoring), and pushes to Redis queues (db0 memory ingestion, db8 knowledge state). Dashboard depends only on recovery at startup — shows a startup screen while other services come online.

**Shared contracts:** `nova-contracts/` is a Pydantic-only package defining the API contract between services (chat, llm, memory, orchestrator models). Any service satisfying these models is a drop-in replacement.

**Quartet Pipeline:** 5-stage agent chain — Context → Task → Guardrail → Code Review → Decision. Runs via Redis BRPOP task queue with heartbeat (30s) and stale reaper (150s timeout). Pipeline code lives in `orchestrator/app/pipeline/`. The task stage can park mid-flow on the `request_human_checkpoint` tool (status `waiting_human`; conversation snapshotted to `tasks.checkpoint._human_checkpoint`; kind='checkpoint' row in `approval_requests`); the operator's decide (+ free-text reply) resumes it through the approval worker with the reply injected as the tool result.

**Redis DB allocation:** orchestrator=db2, llm-gateway=db1, chat-api=db3, memory-service=db0, db4=unused (was chat-bridge), cortex=db5, intel-worker=db6, recovery=db7, knowledge-worker=db8, voice-service=db9, browser-worker=db11.

## Build & Run Commands

```bash
# First-time install (interactive wizard: mode selection, .env, GPU detect,
# model pulls, services up). Renamed from ./setup → ./install on 2026-04-28.
./install

# Production boot-up after install (idempotent: build + up + wait for health)
./start

# Remove Nova from this machine (preview-first, then 'type uninstall' to confirm)
./uninstall

# Dev with hot reload
make dev          # or: docker compose up --build --watch
make watch        # sync Python source into running containers
make logs         # tail all container logs
make ps           # container status

# Production
make build        # rebuild all images
make up           # start detached
make down         # stop all

# Local inference is hybrid: bundled containers (Ollama / vLLM / SGLang /
# llama.cpp as compose profiles inference-*, started from Settings → Local
# Inference or COMPOSE_PROFILES) OR external servers you run yourself (LM Studio
# and Custom are external-only). GPU: COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
# (written by ./install on positive NVIDIA detection).

# Backup / Restore (emergency CLI — normally use the Recovery UI at /recovery)
make backup               # create a database backup to ./backups/
make restore              # list available backups
make restore F=<file>     # restore a specific backup

# Cleanup (NEVER run raw docker system prune — use these instead)
make prune                # remove containers, images, build cache (preserves ALL volumes)
make prune-all            # backup DB first, then prune + remove model cache volumes
```

**Dashboard dev server:** Runs on port 5173 via Vite with proxy to backend services. Production uses nginx on port 3000.

**DB migrations:** Run automatically at orchestrator startup from `orchestrator/app/migrations/*.sql`. No Alembic — pure versioned SQL files run idempotently.

## Testing

```bash
make test          # Full integration suite (~550 tests, ~45 min with LLM-backed pipeline tests, requires services running)
make test-quick    # Health endpoints only (~0.4s)
```

Integration tests live in `tests/` at the repo root. They hit real running services over HTTP/WebSocket — no mocks. Pipeline tests are opt-in (skipped unless an LLM provider is configured). Tests create resources with `nova-test-` prefix and clean up via fixture teardown. A per-test 180s timeout (pytest-timeout, signal method) is configured in `tests/pytest.ini` — do not switch it to the thread method, which kills the whole session on first timeout. Test deps are single-sourced from `tests/requirements.txt`.

Additional validation:

- Dashboard: `cd dashboard && npm run build` (TypeScript compilation check)
- Each FastAPI service: `/health/live` and `/health/ready` endpoints
- Interactive: chat-api serves a test UI at `http://localhost:8080/`
- API docs: FastAPI auto-docs at `/docs` on each service

## Code Conventions

**Python (all backend services):**

- Async/await throughout (FastAPI + asyncpg + async Redis)
- Config via `pydantic_settings.BaseSettings` reading from `.env`
- Orchestrator and cortex use raw asyncpg queries (no ORM); memory-service has no database at all (OKF markdown files + BM25 index)
- Fault-tolerant: try/except + `logger.warning` — never crash on missing optional config
- **Log levels matter:** ERROR for unrecoverable failures, WARNING for recoverable issues that affect functionality, INFO for state changes, DEBUG for detailed flow. Never log critical failures at DEBUG — they become invisible in production (LOG_LEVEL=INFO).
- **Redis cleanup:** Every service with `get_redis()` must have a corresponding `close_redis()` called in the FastAPI lifespan shutdown path. Connection leaks accumulate across restarts.
- Snake_case everywhere; JSONB for flexible fields; UUID primary keys; TIMESTAMPTZ

**React/TypeScript (dashboard):**

- Functional components only, TanStack Query for server state (staleTime=5s, retry=1)
- Tailwind CSS with stone/teal/amber/emerald palette; Lucide React icons
- API calls via `apiFetch<T>()` in `src/api.ts`; admin secret stored in localStorage

**API design:**

- Raw JSON responses (no `{ data: ... }` wrapper)
- Admin auth: `X-Admin-Secret` header
- API key auth: `Authorization: Bearer sk-nova-<hash>` or `X-API-Key`
- Streaming: SSE with JSON lines

## Memory System

Memory-service exposes a **backend-agnostic API at `/api/v1/memory/*`**. Backends implement `MemoryBackend` (`memory-service/app/backends/base.py`): `write`, `context`, `mark_used`, `feedback`, `provenance`, `stats` (+ optional `explain`, `consolidate`, `reindex`, `delete`). The OKF markdown backend is the only built-in implementation; `memory.provider_url` can point the orchestrator at an external provider serving the same API.

**OKF markdown backend** (`app/backends/okf/`): memory is a folder of markdown files with [OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) frontmatter at `${NOVA_WORKSPACE}/memory/` (bind-mounted into memory-service, so agent file tools and the backend see the same files — you can `cat`/`git` your memory).
- `index.md` (auto-maintained root index, always injected), `log.md` (dated change log), `topics/`/`people/`/`projects/`/`preferences/<slug>.md` (concept files), `journal/YYYY-MM-DD.md` (high-volume inbox), `sources/`, `.nova/` (BM25 index + retrieval log).
- Retrieval is BM25 over `.nova/index.json` (no embeddings, no LLM calls); self-heals on file mtime drift so direct human/agent edits are supported. Links between files are untyped graph edges. Frontmatter maps Nova provenance onto OKF core fields + `nova_*` extensions.
- Queue producers (chat, intel, knowledge, cortex) append digests to the journal; a seeded **"Nightly memory curation"** cron goal (03:00) distills journals into topics. A 45-day journal-retention backstop runs in memory-service regardless of the brain.

**Ingestion queue:** producers push raw text to Redis `memory:ingestion:queue` (db0); the memory-service consumer routes each payload to the active backend's `write`. External apps push through **`POST /api/v1/ingest`** (orchestrator, `app/ingestion_router.py`) — validates, auths (per-source `sk-nova-ingest-*` Bearer tokens minted at `POST /api/v1/ingest/sources`, or operator credentials), rate-limits per source, applies the source's denylist, enforces backpressure (503 + Retry-After past `ingestion.max_queue_depth` in platform_config, default 10k), then LPUSHes the consumer's exact contract. One endpoint for every source — replaces per-source bridge services.

**Orchestrator integration:** `run_agent_turn()` calls `POST /api/v1/memory/context`; memory tool retrievals pass `mark_used=true` (the agent asking IS the usage signal).

### Memory Tools

Agents access memory via tools on the neutral API:

- `what_do_i_know` — lightweight overview (empty-query context → root index)
- `search_memory` — ranked retrieval for a query
- `recall_topic` — comprehensive recall about one entity/topic
- `read_memory` — full content of one memory item by id
- `remember` — write a durable memory (concept file)

Controlled by `memory_retrieval_mode` in `.env` (`inject` for pre-injection, `tools` for agent-driven). Default: `inject`.

## Runtime Configuration (Redis)

Several settings are runtime-configurable via Redis (db 1, prefix `nova:config:`), overridable from the Dashboard UI:

| Key | Values | Effect |
|---|---|---|
| `memory.provider_url` | URL | Advanced: point the orchestrator at an external memory provider serving `/api/v1/memory/*` |
| `inference.backends` | JSON list | **Canonical local-inference inventory (Phase 1 pool):** named entries `{id, kind: container\|remote, engine, url, enabled, auth_header}` the gateway routes over (`llm-gateway/app/pool.py`; CRUD at `/v1/backends`; Models page → Backend pool). Seeded from the scalar keys on first gateway boot after upgrade |
| `inference.backend` | `ollama`, `vllm`, `sglang`, `llamacpp`, `lmstudio`, `custom`, `none` | Legacy scalar mirror of the primary selection — still written by recovery/Settings for older readers; not used for routing once the pool is seeded |
| `inference.state` | `ready`, `starting`, `error`, `draining` | Whether local inference (pool-wide) is accepting requests |
| `inference.url` | URL | Legacy scalar mirror — recovery still writes the in-network URL on bundled start (and clears on stop), but routing reads the pool |
| `inference.lmstudio_url` | URL | LM Studio server URL (default `http://host.docker.internal:1234`) |
| `inference.lmstudio_api_key` | string | Optional bearer token for the LM Studio server |
| `llm.embed_provider` | `auto`, `lmstudio`, `ollama`, `gemini`, `litellm` | Overrides which provider serves embeddings (default `auto` = route by model name). Lets embeddings run on a different server than chat to avoid single-model eviction. |
| `llm.routing_strategy` | `local-first`, `local-only`, `cloud-first`, `cloud-only` | How the gateway routes requests between local and cloud |
| `llm.tier_preferences` | JSON `{"best": [...], "mid": [...], "cheap": [...]}` | Overrides the tier-hint preference lists. Candidates are validated against live discovery at resolve time — stale entries are skipped, never served (`GET /v1/models/tiers` shows verdicts) |
| `notify.enabled` | `true`/`false` | Master switch for phone push via ntfy (default true) |
| `notify.ntfy_url` | URL | In-network ntfy server the orchestrator publishes to (default `http://ntfy`) |
| `notify.ntfy_topic` | string | Seeded `nova-<hex>` topic — the subscription secret shown in Settings → Notifications |
| `notify.action_base_url` | URL | Phone-reachable dashboard URL — enables signed Approve/Deny buttons on pushes (empty = disabled) |
| `notify.action_key` | string | Seeded 64-hex HMAC key signing push action links (internal — never share) |

**Gotcha:** Stale Redis config values survive container restarts. If inference is broken, check `inference.backends` (the pool), `inference.state`, and each entry's `enabled`/`url` in Redis before debugging code (`docker compose exec redis redis-cli -n 1 GET nova:config:inference.backends`). The gateway treats `OLLAMA_BASE_URL=auto`/`host`/empty as aliases for a host-run Ollama (`http://host.docker.internal:11434`). Recovery upserts a container's pool entry on bundled start (front = primary) and disables it on stop; the scalar `inference.backend`/`inference.url` keys are legacy mirrors only.

## Feature Flags

Nova ships a code-first feature-flag system separate from `nova:config:*` runtime config. Flags are declared at module import via `register_flag(...)`; values are read synchronously via `flag.value()`. The orchestrator owns the `feature_flags` and `feature_flag_audit` tables; every other service caches values in-process and re-warms on Redis pubsub `nova:flags:invalidate`.

**SDK** (in `nova-contracts/nova_contracts/`):

- `feature_flags.py` — `FlagDef`, `register_flag`, `flag_override` (test helper), `populate_cache`, `init_cache_file`, `FlagResolver` Protocol, `DefaultResolver`, `set_resolver`/`get_resolver`.
- `feature_flags_http.py` — `warm_cache_from_http(client, base_url)` for bulk pre-warm at lifespan startup.
- `feature_flags_pubsub.py` — `PubsubSubscriber` lifecycle (start/stop, `is_connected` health signal).
- `feature_flags_testing.py` — `registry_clear()` for unit-test cleanup. Production code MUST NOT import this.

**Public read endpoint:** `GET /api/v1/feature-flags/public` (no auth)
returns the allowlisted subset for browser consumption. Allowlist lives
in `orchestrator/app/feature_flags_router.py:PUBLIC_FLAGS` — adding to
it is a security decision (kill switches MUST stay out).

**Dashboard pattern:** `useFeatureFlag<T>(key, default)` in
`dashboard/src/hooks/useFeatureFlag.ts`. Backed by TanStack Query;
returns `default` on missing key, error, or in-flight.

**Naming taxonomy:** see `docs/runbooks/feature-flags.md`. TL;DR:
`kill.*` (emergency), `<system>.<behavior>` (toggle), `feature.*.enabled`
(capability gate, temporary), `ui.*` (UX preset/preference).

**Resolution order** in `FlagDef.value()`:

1. `flag_override(...)` context manager (test scope, contextvars-safe)
2. `NOVA_FLAG_<KEY>` environment variable (boot-time only — changing at runtime requires container restart and emits an audit-bypass WARN log; **not** a hot kill-switch)
3. Registered `FlagResolver` (`DefaultResolver` reads from in-process cache)
4. In-code default

A separate per-service file at `data/flag-cache/<service>.json` is read at startup as a partition-fallback (SR3): kill switches stay armed across restart even when orchestrator/Redis are unreachable.

**Where the system is mounted:**

- Orchestrator router: `orchestrator/app/feature_flags_router.py` at `/api/v1/feature-flags/*` (admin-secret gated).
- Orchestrator store: `orchestrator/app/feature_flags_store.py`.
- Migration `083_feature_flags.sql` (tables) + `085_flag_audit_metadata.sql` (actor_ip/UA/request_id columns).
- Each consuming service's `app/main.py` lifespan starts a `PubsubSubscriber` and calls `warm_cache_from_http` (or `warm_cache_from_store` for orchestrator itself).
- Dashboard UI: Settings → System → Feature Flags (`dashboard/src/pages/settings/FeatureFlagsSection.tsx`).

**CRITICAL_FLAGS** — hardcoded denylist in `orchestrator/app/feature_flags_router.py` and mirrored in the dashboard. PATCH requires `confirm: <key>` body field. Today's set:

```
pipeline.guardrail_strict_mode
pipeline.web_fetch_strict_sanitize
```

**Security-sensitive toggles NOT in the flag system** (v1 deliberate exclusion): `SELFMOD_ENABLED` and the home/root sandbox tiers. They retain `.env` boot-time gating until Phase 2 RBAC + per-write confirmation tokens land — admin-secret-only auth is too weak for "agent gets `$HOME` write" semantics.

## Key Configuration

- `.env` — DB password, admin secret, infra-only knobs (`COMPOSE_PROFILES`, `OLLAMA_BASE_URL`, `NOVA_INFERENCE_MODE`, `VLLM_MODEL`, etc.), `NOVA_WORKSPACE`, `LOG_LEVEL`, `REQUIRE_AUTH`
- `OLLAMA_BASE_URL` — Set to `auto` (probes host, falls back to Docker), `host` (always use host machine), or explicit URL
- `POSTGRES_DATA_DIR` / `REDIS_DATA_DIR` — Host bind-mount paths for critical data (default: `./data/postgres`, `./data/redis`). Immune to `docker volume prune`.
- Local inference: bundled containers (Ollama, vLLM, SGLang, llama.cpp — compose profiles `inference-*`, model dirs via `OLLAMA_MODELS_DIR`/`HF_CACHE_DIR`/`LLAMACPP_MODELS_DIR`) or external servers (LM Studio, any OpenAI-compatible endpoint). Manage in Settings → Local Inference (Redis `inference.*`).
- Context compaction threshold: `context.compaction_threshold` in platform_config (Settings → AI & Pipeline → Context), `.env` value is fallback only. The per-slice pct budgets were removed 2026-07-10 — no allocator ever consumed them.
- Voice: `STT_PROVIDER`, `TTS_PROVIDER`, `TTS_VOICE`, `TTS_MODEL` — voice settings (runtime-configurable via dashboard Settings or Redis `nova:config:voice.*`)

## Platform Secrets (SEC-006a)

Long-lived instance-level credentials live encrypted at rest in the
`platform_secrets` Postgres table — never plaintext in `.env`. Covers LLM
provider keys (Anthropic, OpenAI, Groq, Gemini, Cerebras, OpenRouter,
GitHub, ChatGPT subscription), the
Google OAuth client secret, and the GitHub PAT used for self-modification.

- **Encryption:** AES-256-GCM, envelope-encrypted under an HKDF subkey
  derived from `CREDENTIAL_MASTER_KEY` with tenant id `"platform"`. Same
  primitive that backs per-tenant `capability_credentials`.
- **API:** `GET /api/v1/admin/secrets` (list, no values), `PATCH` (upsert),
  `DELETE /{key}` (revoke), `POST /resolve` (plaintext for service
  consumers — admin-gated). Defined in `orchestrator/app/secrets_router.py`.
- **Boot-time consumers:** `llm-gateway` calls
  `nova_worker_common.platform_secrets.fetch_platform_secrets_sync` at
  module load to override settings/env. Sync because providers/adapters
  capture tokens at construction. The orchestrator itself uses
  `app.secrets_store` directly to avoid a self-HTTP loop.
- **First-boot import:** `_bootstrap_platform_secrets_from_env` in
  `orchestrator/app/main.py` mirrors `.env` values into `platform_secrets`
  on every startup if (and only if) the entry is missing. Idempotent —
  user-rotated values are never overwritten.
- **Rotation UX:** Settings → AI & Models → Provider Status (writes via
  `patchPlatformSecrets`). Changes apply live (FU-009): the orchestrator
  publishes on `nova:secrets:invalidate` after every PATCH/DELETE and the
  llm-gateway re-resolves + reapplies its key overlay
  (`llm-gateway/app/secrets_runtime.py`) without a restart. Availability
  checks read the post-overlay environment — never key material from the
  import-frozen `settings` object.
- **Caveat:** the `.env` mount stays `:rw` until FU-010 migrates infra-only
  keys to `platform_config`; the security boundary is enforced today by
  the recovery whitelist refusing any secret-bearing keys.

## Debugging

Quick diagnostics when something is broken:

```bash
# Container status
docker compose ps

# Service health (all at once)
for p in 8000 8001 8002 8080 8100 8110 8120 8888; do echo -n "localhost:$p → "; curl -sf -m 2 http://localhost:$p/health/ready | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "DOWN"; done

# Redis config state (stale values are a common root cause)
docker compose exec redis redis-cli -n 1 MGET nova:config:inference.backend nova:config:inference.state nova:config:llm.routing_strategy

# Queue depths
docker compose exec redis redis-cli -n 2 LLEN nova:queue:tasks
docker compose exec redis redis-cli -n 0 LLEN memory:ingestion:queue

# Memory system health
curl -s http://localhost:8002/api/v1/memory/stats | python3 -m json.tool

# Recent errors across all services
docker compose logs --tail 30 2>&1 | grep -i "error\|exception" | tail -20
```

## Website & Documentation

Nova's website lives at `website/` (Astro/Starlight, arialabs.ai). The site serves both the Aria Labs company landing page and Nova product pages/docs. After completing feature work, check if any website content needs updating.

**Website structure:**

- `website/src/content/docs/nova/docs/` — Documentation pages (Starlight, served at arialabs.ai/nova/docs/)
- `website/src/content/changelog/` — Release changelog entries
- `website/src/data/features.ts` — Landing page feature list and differentiators
- `website/src/components/` — Landing page components (Hero, FeatureCard, PipelineDiagram, etc.)
- `website/astro.config.mjs` — Sidebar structure (update when adding/removing docs)

**Code-to-docs mapping:**

| Changed area | Website content to check |
|---|---|
| `orchestrator/app/pipeline/` | `nova/docs/pipeline.md` |
| `orchestrator/app/tools/`, MCP integration | `nova/docs/mcp-tools.md` |
| `orchestrator/app/router.py`, API endpoints, `nova-contracts/` | `nova/docs/api-reference.md` |
| `orchestrator/app/auth.py`, secrets, `REQUIRE_AUTH` | `nova/docs/security.md` |
| `orchestrator/app/config.py`, `.env.example`, `models.yaml` | `nova/docs/configuration.md` |
| `llm-gateway/` | `nova/docs/services/llm-gateway.md`, `nova/docs/inference-backends.md` |
| `memory-service/` | `nova/docs/services/memory-service.md` |
| `chat-api/` | `nova/docs/services/chat-api.md` |
| `dashboard/` | `nova/docs/services/dashboard.md` |
| `recovery/` | `nova/docs/services/recovery.md` |
| `cortex/` | (new — no docs yet) |
| `intel-worker/`, `orchestrator/app/intel_router.py` | (new — no docs yet) |
| `knowledge-worker/` | (new — no docs yet) |
| `voice-service/` | `nova/docs/services/voice-service.md` |
| `orchestrator/` (general) | `nova/docs/services/orchestrator.md` |
| `docker-compose*.yml`, `Makefile`, `scripts/setup.sh` | `nova/docs/deployment.md`, `nova/docs/quickstart.md` |
| GPU overlays, inference backends | `nova/docs/inference-backends.md` |
| Service ports, inter-service URLs, new services | `nova/docs/architecture.md` |
| Remote access (Cloudflare, Tailscale) | `nova/docs/remote-access.md` |
| IDE integration (Continue, Cursor, Aider) | `nova/docs/ide-integration.md` |
| Skills framework, `.claude/` config | `nova/docs/skills-rules.md` |
| `docs/roadmap.md` | `nova/docs/roadmap.md` |
| New major feature or capability | `data/features.ts` (landing page), `changelog/` (new entry) |
| New service or architectural change | `components/PipelineDiagram.astro`, `nova/docs/architecture.md` |

**When to update docs:** New features, changed APIs/endpoints, new/changed env vars, new CLI commands, new services, changed ports, changed setup steps, new providers/backends.

**When to add a changelog entry:** After shipping a cohesive set of features (not every commit — group related changes into a release entry in `website/src/content/changelog/`).

**When to update landing page:** New differentiating capabilities, major architectural changes, new platform integrations. Update `features.ts` and relevant components.

**Skip** for internal refactors with no user-visible change.

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:

- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
