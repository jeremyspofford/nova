# Nova AI Platform — Roadmap

> Living document. Restructured 2026-03-25.
>
> **Vision:** A self-directed autonomous AI platform. You define a goal. Nova breaks it into
> subtasks, executes them through a coordinated pipeline of specialized agents with built-in
> safety rails, evaluates its own progress, re-plans as needed, and completes the goal — with
> minimal human intervention except when it genuinely needs a decision.
>
> Previous roadmap with full historical design specs archived at `docs/roadmap-archive-2026-03.md`.

---

## Autonomy Levels

| Level | Description | Status |
|---|---|---|
| **1 — Pipeline autonomy** | Quartet runs all agents without human input. Escalates only on critical flags. | Delivered |
| **2 — Async execution** | Tasks run in background. Submit and come back. | Delivered |
| **3 — Self-aware** | Nova understands its own architecture, config, health; can inspect and modify itself. | Not Started |
| **4 — Triggered execution** | Tasks start from external events — git push, cron, webhook, Slack. | Partial (intel/knowledge polling) |
| **5 — Reactive** | Nova watches continuous streams, applies AI judgment, acts autonomously. | Not Started |
| **6 — Self-directed** | Nova breaks goals into subtasks, executes, evaluates, re-plans, loops to completion. | Partial (P1 Autonomous Loop code delivered 2026-04 — runtime verification + goal decomposition + maturation executor remain) |

---

## What's Shipped

Everything below is deployed and functional. Nova runs as a 13-service Docker Compose stack (plus optional profiles for Ollama, chat-bridge, knowledge-worker, voice-service, screenpipe-bridge)
with PostgreSQL (pgvector), Redis, and optional profiles for bridges, knowledge, and inference backends.

### Recent major releases

See the [changelog](https://arialabs.ai/changelog/) for full notes:

- **2026-05-06** — Memory subsystem hardening (P1 + P2 cliff queries fixed; 214 unit tests on real Postgres + pgvector)
- **2026-05-05** — Platform secrets store (provider keys + bridge tokens move out of writable `.env`; recovery's Docker SDK gated behind socket-proxy)
- **2026-05-02** — Personal context capture (`screenpipe-bridge` service + Capture top-level dashboard nav)
- **2026-05-01** — Capability Platform (consent gate, encrypted credential vault, hash-chained audit log, autonomous CI triage drive — v1 release gate)

### Core Platform & Orchestrator (Port 8000)

Agent lifecycle management with 11-state task machine. Auto-run SQL migrations (pure SQL, no Alembic). Task queue via Redis BRPOP with heartbeat (30s) and stale reaper (150s). Shared contracts library (`nova-contracts/`) defining Pydantic API shapes used by all services.

- Multi-turn agent loop with tool use and streaming
- Pod/agent configuration stored in DB, editable via dashboard
- Intel router: feed CRUD, content ingestion, recommendations, comments
- Knowledge router: source CRUD, credential management, manual paste
- Goal management with maturation status tracking
- MCP server registration and tool dispatch
- API key auth (`sk-nova-*`, SHA-256 hashed) + admin auth + RBAC scaffolding
- OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`) for IDE integration

### LLM Gateway (Port 8001)

Multi-provider model routing with 27+ provider files.

- **Providers:** Ollama, Anthropic, OpenAI, Groq, Gemini, Cerebras, OpenRouter, GitHub Models, vLLM, SGLang, Claude/ChatGPT subscription, remote OpenAI-compatible
- **Routing strategies:** local-only, local-first, cloud-only, cloud-first
- **Intelligent routing:** Classifier-based (general/code/reasoning/creative/quick) with cascading classifier models (Ollama → Groq → Cerebras), per-category model preference lists, auto-fallback
- Auto model resolution with 30s caching, quality-ranked preference list, vLLM availability tracks Redis config (fixed 2026-03-28)
- Response caching (300s TTL), rate limiting (Redis sliding window)
- Token counting + cost tracking via LiteLLM
- SSE metadata events (model, category) before content deltas

### Engram Memory System (Port 8002)

Graph-based cognitive memory. 8 node types (fact, episode, entity, preference, procedure, schema, goal, self_model), typed/weighted edges, spreading activation retrieval.

- **Ingestion** — Async Redis queue worker decomposes raw text into structured engrams via LLM. Entity resolution, contradiction detection, edge creation. Backpressure via Semaphore(5).
- **Spreading Activation** — Graph traversal via recursive CTE. Seeds by cosine similarity, then spreads through weighted edges. <100ms.
- **Working Memory** — `assemble_context` reads activation results, sticky decisions, and open threads, then trims by token budget. The `working_memory_slots` table has 5 named slot types (pinned/sticky/refreshed/sliding/expiring) reserved for future runtime promotion/demotion logic; today only sticky is actively written. Background cleanup every 5 min.
- **Consolidation** — 6-phase "sleep cycle": replay, pattern extraction, Hebbian learning, contradiction resolution, pruning/merging, self-model update. Mutex-protected, 3 triggers (idle/nightly/threshold).
- **Outcome Feedback** — Post-LLM scoring adjusts engram activation/importance.
- **Neural Router** — Full PyTorch training pipeline (878 lines, ScalarReranker + EmbeddingReranker). Activates organically after 200+ labeled retrieval observations.
- 3-tier embedding cache (Redis L1 → PostgreSQL L2 → Gateway L3) with write-through

### Quartet Pipeline

5-stage agent chain: Context → Task → Guardrail → Code Review → Decision.

- Redis BRPOP task dispatch with checkpointing
- 11 task states: `submitted → queued → context_running → task_running → guardrail_running → review_running → pending_human_review → completing → complete | failed | cancelled`
- Clarification support — Context Agent detects ambiguity, pauses for user input via `POST /clarify`
- Parallel agent groups (Guardrail + Code Review run concurrently)
- Per-agent configurability: model, temperature, max_tokens, timeout, system_prompt, allowed_tools, run_condition, output_schema
- Per-pod configurability: max_cost_usd, max_execution_seconds, require_human_review, routing_keywords/regex

### Cortex — Autonomous Brain (Port 8100)

Thinking loop with cognitive drives, goal management, and budget tracking.

- BRPOP hybrid loop with adaptive timeout (active fast → idle slow)
- One cycle: PERCEIVE → EVALUATE → PLAN → ACT → REFLECT
- 5 drives: Serve (user goals), Maintain (health), Improve (contradictions), Learn (consolidation), Reflect (self-model)
- Token budget tracking with tier-based throttling
- Goal management with iterations, success criteria, cost tracking
- Stimulus system: Redis BRPOP for event-driven reactivity
- Scheduler: periodic checks for idle goals, expired tasks
- Maturation: goals track stages (triaging → scoping → speccing → review → building → verifying)

### Intel System (Port 8110)

Autonomous AI ecosystem feed poller. Feed ingestion is operational; recommendation generation is not yet implemented.

**Shipped:**
- 5 fetcher types: RSS, Reddit JSON, page change detection, GitHub trending, GitHub releases
- Configurable polling intervals per feed, exponential error backoff (capped 24h)
- Content dedup via hash, SSRF validation on all URLs
- Pushes to engram ingestion queue + intel notification queue
- 14 default feeds seeded by migration
- Orchestrator endpoints: feed CRUD, content ingestion, recommendation CRUD, comments
- Dashboard: feed management, recommendation browsing, suggested goals tab
- Database schema: intel_feeds, intel_content_items, intel_recommendations, linkage tables

**Recently delivered (P1 Autonomous Loop Activation, Tier 3 — 2026-04):**
- ✅ Recommendation generation — `POST /api/v1/intel/recommendations` endpoint shipped (`intel_router.py:358`); Cortex MCP tools in `intel_tools.py` (`query_intel_content`, `create_recommendation`, `get_dismissed_hashes`); system goals seeded by migration `040_intel_system_goals.sql`. Runtime population of `intel_recommendations` table needs live cycle confirmation.
- ✅ `intel:new_items` Redis queue dead letter — push removed (zero project references remain).

**Not yet implemented:**
- Goal maturation pipeline — maturation stages defined in schema but Cortex drive logic to execute them is not built.
- See spec: `docs/superpowers/specs/2026-03-25-intelligence-and-goal-maturation-design.md`
- See analysis: `docs/superpowers/specs/2026-03-28-platform-health-analysis.md`

### Knowledge Sources (Port 8120)

Autonomous personal knowledge crawler. Optional service (`--profile knowledge`).

- LLM-guided web crawler with BFS, relevance scoring, circuit breaker
- robots.txt compliance, per-domain rate limiting, SSRF validation per hop (including redirects)
- GitHub API extractor (profile, repos, READMEs, activity)
- Encrypted credential storage (AES-256-GCM envelope encryption via nova-worker-common)
- Credential health check background task (every 6h)
- Dashboard Sources page (Personal/Feeds/Shared tabs)
- Manual content paste → engram ingestion

### Chat System

- **Chat API** (Port 8080) — WebSocket streaming bridge (SSE-to-WebSocket), session management with conversation history, test UI at `/`
- **Chat Bridge** (Port 8090) — Telegram + Slack adapters with message relay, markdown conversion, context forwarding. Optional (`--profile bridges`)

### Dashboard (Port 3000/5173)

React admin UI with 20 functional pages. Vite + Tailwind (stone/teal/amber/emerald) + TanStack Query + Lucide React icons.

- **Core:** Overview (live agent cards), Chat (WebSocket streaming), Tasks (board + lifecycle)
- **Configuration:** Pods (CRUD + agent config), Models (39 models by provider), Goals (create/manage + maturation + recommendations)
- **Data:** Sources (knowledge + intel unified), Memory (engram explorer + graph viz + source attribution)
- **System:** MCP (server list + tool catalog), Settings (API keys, routing, auth, inference), Recovery (backup/restore)
- **Admin:** Keys, Users, Friction, AgentEndpoints, About, Invite, Login

### Recovery Service (Port 8888)

Dedicated backup/restore and service management. Only depends on postgres — stays alive when other services crash.

- PostgreSQL backup/restore to disk
- Factory reset
- Docker socket integration for container lifecycle management
- Ollama model management + hardware detection
- Backend lifecycle controller (start/stop/drain/health monitor)

### Managed Inference Backends

Full inference backend lifecycle with hardware-aware recommendations. Shipped across 4 sub-phases (12a-12d).

- **Backends:** Ollama, vLLM, SGLang, remote OpenAI-compatible endpoints
- **Hardware detection:** `detect_hardware.sh` → `data/hardware.json` → Redis sync (db7)
- **Lifecycle:** Start/stop via Docker Compose profiles, drain protocol (set draining → poll inflight → stop old → start new → wait healthy → set ready), health monitor (30s, 3 failures → restart with exponential backoff)
- **Model library:** Backend-aware Models page, HuggingFace catalog search, curated recommendations, VRAM-aware filtering
- **Onboarding wizard:** 6-step first-visit flow (hardware → engine → model → download → ready)
- **GPU monitoring:** nvidia-smi via docker exec, inference performance metrics (`GET /v1/inference/stats`)
- **Dashboard:** Local Inference settings section, GPU stats cards, recommendation banner

### Auth & Security

- API key auth (SHA-256 hashed, `sk-nova-*`) with per-key rate limiting (Redis sliding window)
- Admin-only endpoints, `REQUIRE_AUTH=false` dev bypass
- RBAC: 5 roles (Owner > Admin > Member > Viewer > Guest) with `RoleDep(min_role=...)` FastAPI dependency
- JWT claims with role + tenant_id (backwards-compatible `is_admin`)
- Guest isolation: no tools, no memory, no system context, admin-configured model allowlist
- OpenAI-compatible endpoints for Continue.dev, Cursor, Aider integration
- SSRF protection across all URL-handling services (intel, knowledge, orchestrator)

### Remote Access & Mobile

- Cloudflare Tunnel sidecar (`--profile cloudflare-tunnel`)
- Tailscale sidecar (`--profile tailscale`)
- PWA manifest + service worker (installable to home screen)
- WebSocket auth (API key on `/ws/chat`), CORS lockdown (`CORS_ALLOWED_ORIGINS`)
- HTTPS indicator in NavBar, setup wizard remote access selection

### Platform Hardening

Cross-cutting reliability work shipped across hardening phases:

- Structured JSON logging with async ContextVar correlation (task_id, agent_id) across all services
- Redis connection leak cleanup — every service with `get_redis()` has corresponding `close_redis()` in lifespan shutdown
- MCP tools visible to agents (replaced static `ALL_TOOLS` with `get_all_tools()`)
- Streaming token counts fixed (`stream_options={"include_usage": True}` for subscription providers)
- Reaper race condition fixed (Redis SADD dedup gate before LPUSH, CAS UPDATE in reaper)
- Gateway auto-resolves `OLLAMA_BASE_URL=auto` (probes host, falls back to Docker)
- Consolidation: 7-day review window, young edge protection (<7d immune to decay), mutex, phase isolation
- Ingestion: backpressure (Semaphore(5)), JSON validation before processing
- Model auto-resolution: decomposition/reconstruction/consolidation models default to `auto` with probe fallback
- Graceful shutdown: 15-second timeout for background tasks before cancellation

### Testing

- 150+ integration tests hitting real running services (no mocks)
- 22 test files covering: health, pipeline mechanics/behavior, SSRF, intel, knowledge, RBAC, inference backends, memory, recovery, cortex goals, model discovery, consolidation, agent capabilities
- Tests create resources with `nova-test-` prefix, clean up via fixture teardown
- `make test` (full suite, ~2 min) / `make test-quick` (health only, ~0.4s)
- Dashboard: `cd dashboard && npm run build` (TypeScript compilation check)

---

## WIP Snapshot — 2026-04-03 (Historical)

> **Superseded 2026-04-27.** All feature branches listed below were consolidated into main or dropped during repo cleanup; main is the single source of truth. Stash references may also be stale (branches deleted). Section retained for historical context — do not use for current state.

Uncommitted work, stashed branches, and feature branch status as of this date.

### Uncommitted on `main` (5 files)

| File | Change |
|---|---|
| `orchestrator/app/chat_scorer.py` | Fix asyncpg type-inference ambiguity — replaced `BETWEEN ($2 - INTERVAL ...) AND $2` with explicit Python-computed time bounds |
| `orchestrator/app/pipeline/executor.py` | Thread `sandbox_override` from task metadata through `_run_agent()` / `_run_parallel_group()` as a param instead of re-reading metadata inside `_run_agent` |
| `dashboard/src/components/ui/MorphButton.tsx` | UI component changes (may be incomplete) |
| `dashboard/src/pages/chat/ChatInput.tsx` | Chat input change (1 line) |
| `dashboard/src/pages/chat/ChatPage.tsx` | Chat page additions (18 lines, may be incomplete) |

### Stashed Work

| Stash | Branch | Content |
|---|---|---|
| `stash@{0}` | `feat/intelligence-and-goal-maturation` | Platform API credential health validation (actual API calls to verify keys) |
| `stash@{1}` | `main` | Agent fleet spec doc fixes |

### Feature Branches

**Close to landing:**

| Branch | Status |
|---|---|
| `feat/voice-chat` | Voice service works. Node highlighting, rate limiting, cost tracking remain. |
| `feat/source-provenance-memory-tools` | Core delivered (16 tasks). Feedback loop + dashboard toggle remain (small). |

**Blocked / needs work:**

| Branch | Status |
|---|---|
| `feature/p1-autonomous-loop` | Blocked — 5 reinforcing bugs cause infinite skip loop. Tier 1-5 plan exists (~4 days). See P1: Autonomous Loop Activation below. |
| `feat/intelligence-and-goal-maturation` | Has stashed credential validation work. Maturation pipeline is a stub (columns exist, no executor). |
| `feature/cortex-learning-from-experience` | Spec complete (`docs/specs/2026-03-28-cortex-learning-from-experience.md`), implementation not started. |

**Stale — triage before resuming:**

| Branch | Status |
|---|---|
| `feature/unified-chat-pwa` | Telegram integrations broken. Needs investigation. |
| `feature/design-pass-p1` | Unknown progress — review branch state. |
| `feat/ide-integration-onboarding` | Unknown — check branch state. |
| `feature/nova-mediated-creation` | Remote only — may be superseded by cortex work. |
| `feature/dashboard-nav-restructure` | Remote only — may conflict with recent editor sidebar work. |

---

## In Progress — Partially Delivered

### Voice Chat

Push-to-talk voice interaction for the Brain page.

**Delivered:**
- Voice service microservice (port 8130, profile `voice`) — STT/TTS provider proxy
- OpenAI Whisper STT with silence/hallucination guard
- OpenAI TTS with 6 configurable voices (default: nova)
- Provider abstraction (STTProvider/TTSProvider ABCs) — add providers by implementing one file
- Push-to-talk mic button in BrainChat with recording states and duration limit
- Sentence-buffered TTS playback — parallel synthesis, sequential playback
- Text-to-speakable preprocessor — strips code blocks, URLs, markdown for natural speech
- Echo cancellation and noise suppression on recording
- Mute toggle, blob URL cleanup, transcript queuing during streaming
- Voice section in dashboard Settings (STT/TTS provider, voice, model — runtime-configurable)
- Docker Compose, Vite proxy, nginx proxy, integration tests

**Remaining:**
- **Node highlighting during retrieval** — infrastructure exists (orchestrator emits `engram_ids` in memory activity step, Brain.tsx calls `highlightNodes`), but highlighting not visually confirmed. Likely a timing issue (nodes may not match graph data IDs) or the Three.js opacity/scale boost in the tick loop isn't visible enough. Needs debugging.
- Redis sliding window rate limiting for TTS requests
- Cost tracking (per-request STT/TTS cost to Redis, dashboard display)
- **Full-panel voice mode UI** — Layered Core orb overlay, per-session toggle, bidirectional STT+TTS conversation from main chat view. Spec: `docs/superpowers/specs/2026-05-14-voice-mode-full-panel-design.md`
- Speaker identification via voiceprint enrollment (v2)
- **Wake word / ambient always-listening (v2)** — "Hey Nova" activation, always-on VAD, continuous mic permission model
- **Voice mode on mobile (v2)** — mobile-optimised orb layout, overlay z-index handling with mobile browser chrome

### Pipeline Performance

Chat latency optimizations and intelligent routing shipped. Deeper pipeline optimizations remain.

**Delivered:**
- Skip tool pre-resolution for interactive chat (~40-50% first-token improvement)
- Auto model detection with quality-ranked preference list and 30s cached resolution
- Intelligent routing with classifier, per-category model maps, SSE metadata, Settings UI
- Ships disabled by default (`llm.intelligent_routing = false`), graceful fallback

**Remaining:**
| Optimization | Expected Impact |
|---|---|
| Prompt caching for Anthropic models (static pipeline system prompts) | 1-5s + 50-90% cost reduction on cached tokens |
| Right-size models per pipeline stage (Context → cheap, Task → best) | 3-8s savings |
| Speculative pipeline execution (overlap Guardrail with late Task Agent) | 3-7s overlap savings |
| Streaming-first chat (eliminate pre-resolution entirely) | Near-instant first token |
| Memory context pre-warming for active sessions (Redis cache, 60s TTL) | 200-500ms per message |
| Stage merging for simple tasks (skip Context Agent, give Task read-only tools) | 5-10s on simple tasks |
| Adaptive stage skipping via complexity classifier | 2-10s on eligible tasks |

Full design spec: `docs/superpowers/specs/2026-03-17-performance-optimization-design.md`

### Dashboard Enhancement

Pod management and core settings done. Advanced pipeline visibility and settings expansion remain. Brain page visual overhaul planned — see **P1: Brain Visual Overhaul** in Priority Backlog.

**Delivered:**
- Pod management page with full CRUD and per-agent configuration
- Model switcher dropdown (persists to localStorage)
- Settings sections: API keys, routing strategy, auth, local inference, GPU stats, model recommendations
- Theme system with presets

**Remaining:**
- Pipeline editor — agents as draggable cards in sequence, click to configure
- Session replay — step through any agent session message-by-message
- Activity feed — real-time SSE event stream of all agent actions
- Review queue — human-in-the-loop approve/reject for escalated tasks
- .env editor — masked inputs for secrets, restart warnings for non-runtime values
- models.yaml editor — add/remove Ollama models for auto-pull
- Provider status panel — per-provider API key present, last call, ping, test button
- Context budget editor — tune system/tools/memory/history/working split
- Log viewer — SSE-streamed log tail, filterable by service and level
- Guardrail findings feed — dedicated view with severity, resolution, context

### Self-Directed Autonomy

Cortex brain loop works. The feedback loop that makes it actually autonomous is missing.

**Delivered:**
- Cortex thinking loop with adaptive timeout
- 5 cognitive drives with priority-based selection
- Goal management with iterations, success criteria, cost tracking
- Budget tracking with tier-based throttling
- Stimulus system for event-driven reactivity
- Scheduler for periodic health checks

**Remaining — Cortex gaps identified by audit (updated 2026-03-28):**

| Gap | Impact | Effort |
|---|---|---|
| ~~**No task completion feedback**~~ | ~~Cortex dispatches tasks then never checks results~~ | ✅ Delivered (TRACK phase) |
| ~~**Hardcoded outcome scores**~~ | ~~Reports 0.2 or 0.7 — no actual measurement~~ | ✅ Delivered (status-based scoring) |
| ~~**No goal progress tracking**~~ | ~~`progress` field never updated~~ | ✅ Delivered (iteration-based progress) |
| ~~**Cost tracking pipeline broken**~~ | ~~`cost_so_far_usd` never written — 3 gaps in the data pipeline~~ | ✅ Fixed 2026-03-28 |
| ~~**Goals stuck — LLM planner always skips**~~ | ~~Serve drive sends only title (no description/history/plan) to planner. "skip" escape hatch too easy. `last_checked_at` not updated on skip → infinite 30s loop. 6700+ wasted cycles.~~ | ✅ Delivered (P1 Autonomous Loop, Tier 1, 2026-04) |
| **No goal decomposition** | Can't break "build a feature" into subtask DAG. One blob per cycle. | 2-3 weeks |
| **Maturation pipeline stub** | Status columns exist but no executor transitions goals through phases | 2-3 days |
| **No learning from failures** | Writes reflections but never reads them back. **Spec complete** — see `docs/specs/2026-03-28-cortex-learning-from-experience.md` | 1 week |
| **Partial test coverage** | `test_cortex_goals.py` covers cost tracking + goal schema. Full thinking loop tests still needed. | 2 days |

### RBAC & Multi-Tenancy

Role schema and basic enforcement shipped. Full data isolation remains.

**Delivered (Phase 13a):**
- Role/tenant columns on users + invite_codes tables
- Tenants table (single row), audit_log table
- `RoleDep(min_role=...)` FastAPI dependency replacing `AdminDep`
- JWT claims with role + tenant_id
- Guest isolation: no tools, no memory, filtered model access
- User management endpoints + dashboard Users page
- Invite creation with role assignment

**Remaining:**
- `tenant_id` scaffolding on: tasks, memories, api_keys, usage_events
- All data queries scoped by tenant_id + user_id
- Memory service: tenant-scoped embedding retrieval (pgvector filter)
- Redis key namespacing (`tenant:{id}:` prefix)
- Per-user settings (appearance, default model, notifications)
- Role-based nav visibility (Guest sees Chat only, Viewer is read-only)
- Expiry check on every request + Redis deny-list for immediate revocation

**Audit findings (2026-05-01) — backlog, not production-blocking for single-tenant deploys:**

A targeted audit identified specific tier-1 (read leakage) and tier-2 (write-side) gaps where queries don't filter by tenant_id. These are **not blocking the single-tenant production path** but should be addressed before any multi-tenant SaaS launch.

Read-side gaps (any authenticated user can read another tenant's row by guessing UUID):
- `goals_router.py`: list, single-read, stats, scope, iterations, artifacts, comments
- `pipeline_router.py`: tasks list, task detail, findings, reviews, sessions, artifacts

Write-side gaps (INSERTs hardcode/default tenant_id instead of pulling from `user.tenant_id`):
- `goals_router.py:135` (POST /api/v1/goals)
- `goals_router.py:438` (POST /api/v1/goals/{id}/comments)
- `goals_router.py:318` (DELETE /api/v1/goals/{id} — no tenant check)
- `pipeline_router.py:147` (POST /api/v1/pipeline/tasks)

When work resumes: stage per route group (goals → pipeline → comments), one PR per group, with regression tests asserting "user A's request can't read user B's row."
- `/invite/{code}` route with registration flow
- Audit logging for role changes, invites, deactivations

Design: `docs/plans/2026-03-08-rbac-invitations-design.md`, `docs/plans/2026-03-10-phase13a-completion-design.md`

### Knowledge Sources Completion

Service is functional. Credential flow and dedup need finishing.

**Remaining:**
- Wire credential retrieval for authenticated crawls (`scheduler.py:111` TODO — encryption infra exists, just needs orchestrator API call to fetch + decrypt)
- Implement actual platform API health checks (call GitHub `/user` with token to verify validity)
- Per-source crawl dedup (track active crawl tasks to prevent duplicate concurrent crawls)
- Connect BuiltinCredentialProvider to the CredentialProvider ABC (make pluggable interface real)
- Future: GitLab, Bitbucket, social media extractors

### Source Provenance & Memory Tools

Source tracking, richer decomposition, and agent-driven memory retrieval. Delivered across 16 implementation tasks.

**Delivered:**
- Sources table with hybrid storage (DB/filesystem/URI), content-hash dedup, trust scoring
- Source provenance linkage on all engrams (source_ref_id, source_meta)
- Paragraph-level decomposition prompts (replacing atomic fact extraction)
- Fact-level dedup during ingestion (0.90 cosine threshold)
- Temporal validity tracking on engrams (permanent/dated/unknown)
- 4 agent-callable memory tools: what_do_i_know, search_memory, recall_topic, read_source
- Domain awareness priming mode (alternative to 40% context pre-injection)
- Hierarchical source summarization at ingestion time
- Knowledge gap and staleness detection in domain summary
- Re-decomposition endpoint for stored sources
- Dashboard Sources tab in Memory Explorer
- Fixed broken post-pipeline memory extraction payload

**Remaining:**
- Memory tool retrieval feedback loop (tracking which engrams agents actually use)
- Dashboard toggle for memory_retrieval_mode (currently .env only)
- Runtime-configurable memory_retrieval_mode via Redis config

---

## Priority Backlog

Ordered by dependency and impact on the autonomy vision. Detailed design specs for items marked with `[spec]` are preserved in `docs/roadmap-archive-2026-03.md`.

### ✅ P0: Pipeline Reliability Hardening `[spec]` — Delivered 2026-03-25

**Delivered in commits `f990eb8` (Tier 1) and `d0e30fc` (Tier 2).**

| Fix | Description | Status |
|---|---|---|
| Pydantic output models | `schemas.py` — typed models for all 5 pipeline agents, validated in `think_json()` | ✅ Delivered |
| Schema in retry prompt | `think_json()` retries with full JSON schema definition on validation failure | ✅ Delivered |
| Full stack traces | `traceback` TEXT column on `agent_sessions` (migration 044) | ✅ Delivered |
| Structured error objects | `error_context` JSONB on `tasks`: `{type, message, stage, model, elapsed_ms, retryable}` | ✅ Delivered |
| Always store agent output | `_last_raw_output` captured before raising parse errors, stored in `agent_sessions.output` | ✅ Delivered |
| Task state CAS transitions | `state_machine.py` — `VALID_TRANSITIONS` map, CAS `UPDATE ... WHERE status = $old` | ✅ Delivered |
| Terminal state protection | Terminal states (complete/failed/cancelled) have empty transition sets | ✅ Delivered |
| Structured error classification | `checkpoint.py` — classify by exception type, exponential backoff, old substring matching as fallback | ✅ Delivered |
| Heartbeat failure counter | 3 consecutive failures → `asyncio.Event` cancellation signal → pipeline abort | ✅ Delivered |
| Critical parallel group handling | Guardrail/code_review crash in parallel group now fails pipeline instead of silently continuing | ✅ Delivered |
| Prompt security — XML boundaries | Wrap user input in `<USER_REQUEST>` tags, escape code review feedback | Not yet |
| Checkpoint save retry | 3x retry with backoff before giving up | Not yet |

### 🔄 P0: Platform Self-Introspection `[spec]` — Partially Delivered 2026-03-26

**Diagnosis tools, self-knowledge, and read-only introspection delivered. Write tools and proactive behaviors remain.**

| Component | Description | Status |
|---|---|---|
| **Architecture context block** | `_build_self_knowledge()` in `runner.py` — services, ports, pipeline stages, memory, cortex, diagnostic tool usage instructions injected into chat system prompt. Gated on `NOVA_SELF_KNOWLEDGE` env var. | ✅ Delivered |
| **Task diagnosis tools** | `diagnosis_tools.py` — 5 tools: `diagnose_task`, `check_service_health`, `get_recent_errors`, `get_stage_output`, `get_task_timeline`. Registered in tool catalog under "Diagnosis" group. | ✅ Delivered |
| **Read-only platform tools** | `introspect_tools.py` — 4 tools: `get_platform_config` (namespace filter, secret masking), `list_knowledge_sources` (URLs/status/credentials), `list_mcp_servers` (connection status + tool catalogs), `get_user_profile`. Registered under "Introspect" group. | ✅ Delivered |
| **Write tools with confirmation** | `update_config`, `manage_providers`, `manage_mcp_servers` — preview + "Apply?" prompt | Not yet |
| **Proactive behaviors** | Health monitoring, config suggestions, capability discovery, self-diagnosis on error | Not yet |

Safety: read tools unrestricted, write tools require confirmation, service restarts require explicit approval, all self-modifications audit-logged, no source code modification.

### ✅ P1: Cortex Task Feedback Loop — Delivered 2026-03-25, cost fix 2026-03-28

**Delivered in commit `f990eb8` (Tier 1). Cost pipeline fixed 2026-03-28.**

- ✅ New TRACK phase in thinking cycle (between ACT and REFLECT) — `task_tracker.py` polls orchestrator for task completion
- ✅ Outcome scores based on actual task status: complete=0.8, complete+findings=0.6, failed=0.2, cancelled=0.1, timeout=0.5
- ✅ Goal progress updated based on iteration count vs max_iterations
- ✅ Failed task errors stored in goal `current_plan` metadata for next cycle's LLM planning
- ✅ Goal cost tracking — 3-gap pipeline fixed 2026-03-28: `executor.py` rolls up agent_session costs to `tasks.total_cost_usd`, `pipeline_router.py` includes cost in task detail response, `task_tracker.py` carries cost in `TaskOutcome`, `cycle.py` accumulates cost on every goal update
- Integration tests for cortex goal lifecycle — partial (`test_cortex_goals.py` covers cost + schema)
- ✅ Read prior reflections before planning — `cortex/app/reflections.py` + migration `048_cortex_reflections.sql` shipped (commit `95ad5d6 feat(cortex): restore all reflection learning files`)

### ✅ P1: Autonomous Loop Activation — Delivered 2026-04 (runtime verified 2026-04-27)

**Status (2026-04-27):** All 5 tiers shipped and runtime-verified. Code spot-checks: serve drive enriched (`serve.py:30-44`), `MAX_CONSECUTIVE_SKIPS = 3` + skip persistence (`cycle.py:38, 459-463, 476-477`), POST recommendations endpoint (`intel_router.py:358`), Sidebar shows "Knowledge", `intel:new_items` push removed. Tier 4 EngramExplorer rename moot (file no longer exists). Runtime evidence: all 9 P1 tests pass (`test_cortex_loop.py` + `test_intel_recommendations.py`); cortex cycle 22394+ shows steady "Dispatched task" outcomes (zero skip loops); 19 active goals advancing autonomously; `intel_recommendations` table populated with 20 rows (5 real intel-feed-derived); `intel:new_items` queue depth = 0 (dead letter leak confirmed fixed).

**Why:** The autonomous loop infrastructure is built (Cortex, Intel, Memory, Goals, Recommendations) but the end-to-end flow is broken at multiple integration points. Goals never dispatch tasks. Intel never generates recommendations. The chat agent can't verify its own state. Fixing these turns "infrastructure exists" into "Nova actually does things autonomously."

**Analysis:** `docs/superpowers/specs/2026-03-28-platform-health-analysis.md`

**Phase structure:** 5 sequential tiers, each independently shippable. Work serially to minimize conflicts.

#### Tier 1: Unblock the goal execution loop (~1 day)

The cortex thinking loop runs 6700+ cycles producing nothing because the LLM planner always says "skip." Five reinforcing bugs create an infinite no-op loop.

| Fix | File(s) | Description |
|---|---|---|
| Enrich planning context | `cortex/app/drives/serve.py` | Query `description`, `current_plan`, `iteration`, `max_iterations`, `cost_so_far_usd` — not just title/priority |
| Remove easy skip | `cortex/app/cycle.py` | Restructure prompt: require a plan when urgency > 0. Move skip to structured output with mandatory reason. |
| Update `last_checked_at` on skip | `cortex/app/cycle.py` | Prevent the same stale goal from triggering every 30 seconds |
| Fix adaptive timeout for skips | `cortex/app/cycle.py` | Set `action_taken` to `"idle"` on skip so timeout stays long (5min), not short (30s) |
| Add skip counter → forced action | `cortex/app/cycle.py` | After 3 consecutive skips, force dispatch with drive's proposed_action or escalate to user |
| Enforce max_iterations/max_cost | `cortex/app/drives/serve.py` | Exclude goals where `iteration >= max_iterations` or `cost_so_far_usd >= max_cost_usd` from stale query |

**Verification:** Cortex logs show `outcome=Task dispatched` instead of `outcome=Skipped`. Goals advance past iteration 1.

#### Tier 2: Agent self-awareness tools (~0.5 day)

The chat agent makes false claims about consolidation and its own capabilities because it has no tools to verify system state.

| Fix | File(s) | Description |
|---|---|---|
| `get_consolidation_status` tool | `orchestrator/app/tools/memory_tools.py` | Wraps `GET /consolidation-log?limit=5`. Agent can verify consolidation is running. |
| `get_memory_stats` tool | `orchestrator/app/tools/memory_tools.py` | Wraps `GET /stats`. Agent can verify engram count, last ingestion time. |
| `trigger_consolidation` tool | `orchestrator/app/tools/memory_tools.py` | Wraps `POST /consolidate` with cooldown check. |
| Expand self-knowledge narrative | `orchestrator/app/agents/runner.py` | Add "What I Can Do" section describing all 7 tool groups, not just 5 diagnosis tools. Add missing services (voice, chat-bridge). |
| Metacognition guidance | `orchestrator/app/agents/runner.py` | Add "verify before asserting" pattern to self-knowledge block. |
| Expose all tools in catalog | `orchestrator/app/tools/__init__.py` or tool router | Add Diagnosis, Introspect, and Memory groups to `/api/v1/tools` response. |

**Verification:** Ask chat agent "is consolidation working?" — it calls `get_consolidation_status` and gives a factual answer.

#### Tier 3: Intel recommendation pipeline (~1-2 days)

14 feeds produce 711 items/week but 0 recommendations. The grading step was never built.

| Fix | File(s) | Description |
|---|---|---|
| `POST /api/v1/intel/recommendations` | `orchestrator/app/intel_router.py` | Create endpoint for recommendation insertion. |
| Intel MCP tools for Cortex | `orchestrator/app/tools/intel_tools.py` (new) | `query_intel_content`, `create_recommendation`, `get_dismissed_hashes` — let Cortex grade content via system goals. |
| System goal descriptions | Migration or seed update | Add concrete descriptions and success criteria to "Daily Intelligence Sweep" and "Weekly Intelligence Synthesis" goals. |
| Drain dead queue | `intel-worker/app/queue.py` | Either add a consumer for `intel:new_items` (db6) or stop pushing to it. Currently leaks memory indefinitely. |

**Verification:** `GET /api/v1/intel/recommendations` returns non-empty list. Dashboard "Suggested" tab shows recommendations.

#### Tier 4: Sources UX clarity (~0.5 day)

Two unrelated concepts share the name "Sources" in the dashboard, causing user confusion.

| Fix | File(s) | Description |
|---|---|---|
| Rename sidebar link | `dashboard/src/components/layout/Sidebar.tsx` | "Sources" → "Knowledge" |
| Rename Engram Explorer tab | `dashboard/src/pages/EngramExplorer.tsx` | "Sources" tab → "Provenance" |
| Fix auth bypass | `dashboard/src/pages/EngramExplorer.tsx` | SourcesTab uses raw `fetch()` instead of `apiFetch()`, skipping auth headers |
| Update help text | Overview.tsx, Sources.tsx, EngramExplorer.tsx | Clarify the distinction in help entries and descriptions |

**Verification:** No two pages share the label "Sources." Auth-gated endpoints work on the Provenance tab.

#### Tier 5: Regression test coverage (~0.5 day)

Tests written during this analysis. Expand to cover the new code from Tiers 1-4.

| Test | File | Covers |
|---|---|---|
| Goal planning context | `tests/test_cortex_goals.py` | Goals return description, current_plan, cost fields |
| Model discovery | `tests/test_model_discovery.py` | vLLM availability matches Redis, all providers listed |
| Consolidation health | `tests/test_consolidation.py` | Consolidation running, log shape, manual trigger |
| Agent tools | `tests/test_agent_capabilities.py` | Tool catalog completeness, memory endpoints functional |
| Recommendation pipeline | `tests/test_agent_capabilities.py` | POST endpoint exists, approve→goal flow works |

**Total effort:** ~4 days, working serially through Tiers 1-5.

### IDE Activity Monitoring — Pending Design (2026-04-27)

**Why:** Nova should observe what's happening in the user's IDE (VS Code, Cursor, Neovim) to learn coding styles, language patterns, and per-repo conventions, feeding signal into engram memory. Today the chat agent has zero visibility into the user's editing context — every conversation starts cold. Persistent IDE telemetry would let Nova develop opinions ("you prefer pytest fixtures over class-based setUp", "this repo uses asyncpg, not SQLAlchemy", "you tend to refactor names mid-session").

**Status:** Mid-brainstorm 2026-04-27 — paused before completion.

**Decisions captured so far:**
- **Primary purpose ranking:** B > C > A — real-time chat context (B) is primary; queryable activity timeline (C) secondary; long-term style/preference learning (A) tertiary and emerges downstream from C+consolidation, not built explicitly first.
- **Privacy/scope model:** UI-configurable in dashboard Settings, backed by Redis (`nova:config:ide_monitoring.*`); pattern-based allowlist (e.g. `~/workspace/**`) + per-context boundaries (Aria/personal/alertventure split per CLAUDE.md) + non-overridable sensitive-file safety net (`**/.env*`, `**/secrets/**`, `~/Obsidian_Vault/**`). No `.env`/YAML config — UI only per `feedback_ui_configurable.md`.
- **Capture content:** Path-only payload (`repo`, `file`, `line`). Nova reads file contents on demand via existing fs/memory tools — avoids duplicating content in transit, shrinks privacy surface. Upgrade to viewport/full-file later only if path-only proves insufficient.

**Still open (resume here):**
- **Platform priority** — Neovim first (primary daily-driver per CLAUDE.md, smaller Lua plugin), then VS Code extension (covers Cursor via fork)? Or both in parallel? Or VS Code first for broader reach? Sanity-check the user's "built in ide" phrasing — external IDE plugin vs. Nova's embedded editor vs. Claude Code's IDE integration.
- **Trigger model** — Push (IDE streams events continuously, Nova caches current state in Redis) vs. pull (Nova queries IDE at chat time) vs. hybrid (events for C/timeline, Redis cache for B/chat).
- **Cross-machine topology** — if Nova ever runs on multiple machines, does the IDE plugin push across a network, or is monitoring local-only per machine? (Currently dev-only on a single host; revisit when topology is real.)
- **Engram ingestion shape** — One episode engram per file-focus event? Aggregated per session? How to dedupe noisy editor signals (rapid file switches, etc.).
- **What chat actually does with the signal** — Auto-injected into every chat turn? Tool-callable (`get_current_editor_state`)? Pinned working memory slot?

**Next step (when resuming):** Continue brainstorming via `superpowers:brainstorming` skill from the platform-priority question, then complete spec → plan → implementation.

### Onboarding Model Recommender — Pending Design (2026-05-04)

**Why:** Today's `./install` wizard picks an inference *mode* (local / hybrid / cloud) but defers model selection to a static default (`qwen2.5:7b`). New users are left guessing which model to actually use. The wizard should detect hardware (RAM, GPU vendor, VRAM) and ask the user's priority (privacy / cost / quality / speed), then recommend a concrete path: local-only with a specific model, hybrid with primary/fallback pair, or cloud-only with a specific provider. Removing this friction reinforces the "local AI is primary" stance by making good local choices the *easy* choice — and gives every new install a working setup tailored to its hardware instead of a one-size-fits-none default.

**Status:** Captured 2026-05-04. Surface area to think through:

- **Hardware detection** — reuse the bundled GPU detection (already drives the NVIDIA/ROCm overlay choice) and probe RAM/CPU. macOS Metal vs. Linux NVIDIA vs. AMD ROCm vs. CPU-only vs. Apple Silicon all hit different model viability bands.
- **Priority elicitation** — one or two questions during the wizard ("privacy-critical?", "cost-sensitive?"); skippable if the user opts into "expert mode" / pre-supplies env vars.
- **Recommendation logic** — rules-based (RAM/VRAM thresholds map to qwen2.5:1.5b / qwen2.5:7b / hermes3:8b / phi4 / etc.) is enough for v1. Don't over-engineer with ML-based prediction.
- **Cloud picks** — depend on which API keys the wizard sees the user enter. If only `GROQ_API_KEY` → recommend `groq/llama-3.3-70b-versatile`. If multiple → recommend by category (cost-tier vs. quality-tier) using current free-tier vs. paid landscape.
- **Update path** — `./install --reconfigure-models` after hardware change (added GPU, freed RAM, etc.) without re-running the full wizard.

**Effort estimate:** ~1 week for v1 (rules-based recommender, basic hardware detection, reuses existing wizard prompts).

**Linked context:** This gap is why the website docs use `qwen2.5:7b` as a generic example rather than per-install recommendations — the install flow is the right place for that personalization, not the docs.

### P1: Skills & Rules System `[spec]`

**Why:** Agent extensibility without code changes. Skills = reusable prompt templates shared across agents/pods. Rules = declarative behavior constraints with pre-execution enforcement, complementing the Guardrail Agent.

**Deliverables:**
- `skills` table — name, content (with `{{param}}` placeholders), scope (global/pod/agent), parameters, priority
- `rules` table — rule_text, enforcement (soft/hard/both), pattern (regex), target_tools, action (block/warn/require_approval)
- `resolve_skills(pod_id, agent_id)` — formatted prompt section, 30s cache
- `check_hard_rules(tool_name, args)` — pre-execution enforcement in `execute_tool()`
- 3 seed rules: no-rm-rf (hard/block), workspace-boundary (soft/block), no-secret-in-output (soft/block)
- CRUD endpoints in pipeline_router.py + Skills/Rules dashboard pages

**Effort:** 2-3 weeks

### 🔄 P1: Brain Visual Overhaul `[spec]` — Partially Delivered 2026-03-29

**Why:** The Brain page is Nova's primary interface — not a dashboard panel. Users will open the app and see the brain, talk to Nova via microphone, and watch memories glow during conversation.

**Spec:** `docs/superpowers/specs/2026-03-28-brain-visual-overhaul-design.md`

**Delivered (Phase 1 + Instanced Rendering):**
- Star shader replaces Fresnel orbs (GPU-driven breathing/fade/highlight)
- Per-node glow sprites removed (UnrealBloomPass handles halos)
- Shared geometry across all nodes (coreGeoRef)
- Per-frame forEach loops eliminated (3 loops removed)
- Minimal HUD layout (stats pill, icon overlays, mic button, settings/topics overlays)
- InstancedMesh rendering — 2000+ draw calls reduced to 1-2 via InstancedBufferAttributes
- Post-stabilization optimization — stops syncing positions after force layout cools
- Lightweight graph API (`/graph/lightweight`) — minimal payload endpoint exists in memory-service
- Plans: `docs/superpowers/plans/2026-03-28-brain-overhaul-phase1.md`

**Remaining — Brain Regression Fixes:**

Instanced rendering shipped but the lightweight API integration and settings persistence were reverted due to regressions. Fixes planned but not yet re-implemented.

| Fix | Description |
|---|---|
| **Lightweight API: add content preview** | Add `LEFT(content, 80)`, `source_type` to node query and `relation` to edge query. Keeps payload small (~380KB) while giving sidebar/connections usable labels. |
| **Settings persistence** | Re-implement `useLocalStorage` hook for Brain display settings (background stars, bloom, edge visibility). Settings should survive page refresh. |
| **Edge visibility toggle** | Re-add `showEdges` prop + settings toggle. Must not be overridden by progressive enhancement. |
| **Progressive enhancement** | Auto-degrade visual quality at high node counts. Must only set defaults, not override explicit user toggles. |
| **Detail modal data merge** | Spread full detail response into selectedNodeData (not just `content`). Fixes "Source unknown" and missing scores. |
| **Brain feature flag** | Per-user toggle in Settings to completely disable Brain (redirect to Chat, hide nav link). |

**Plan:** `.claude/plans/scalable-frolicking-storm.md`

**Remaining — Phase 2 (Configurability):**
- Color mode toggle (domain/type/importance)
- Edge style toggle (static/gradient/animated particles + speed slider)

**Remaining — Phase 3 (Polish):**
- Level-of-detail by zoom distance
- Fix texture cache VRAM leak
- Debounce search query
- Cache CSS color reads

### P2: Nova SDK & CLI `[spec]`

**Why:** External integration layer. Blocks CI/CD automation, scripting, and any non-browser client. Dashboard's `api.ts` duplicates HTTP logic that should live in a typed client.

**Deliverables:**
- `nova-sdk/` — Typed async Python client (httpx), resource modules for every API surface, SSE streaming helper
- `nova-cli/` — Typer + Rich terminal interface: `nova status`, `nova chat`, `nova task submit/list/show/cancel`, `nova pod`, `nova model`, `nova key`, `nova memory`, `nova config`, `nova queue`
- `dashboard/src/types.generated.ts` auto-generated from nova-contracts Pydantic models
- `make types` target for TypeScript generation
- Slim Docker image (`ghcr.io/arialabs/nova-cli:latest`, ~50MB) for CI/CD
- Config profiles (`~/.config/nova/config.toml`) for multiple Nova instances
- `--json` machine-readable output on every command
- TUI (Textual) as follow-up after CLI is stable

**Effort:** 6-8 weeks total

### P2: Browser Automation (Computer Use) `[spec]`

**Why:** Biggest utility gap vs competitors. Nova's agents can read/write files and run shell commands, but can't browse the web or interact with web UIs.

**Architectural decisions (resolved in spec):** CDP Screencast for viewport streaming, watch-only (no user interaction in v1), per-task ephemeral browser instances, Docker Compose profile sidecar.

**Deliverables:**
- Browser container image (Chromium + Playwright), Docker Compose `--profile browser`
- Browser tools: `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_read_page`, `browser_devtools`, `browser_wait`, `browser_tabs`, `browser_evaluate`
- Vision loop: screenshot → vision model (Claude/GPT-4o) → decide action → execute via CDP → repeat
- Dashboard browser viewer: embedded viewport with CDP Screencast, action log sidebar
- Action recording: structured events as task artifacts, post-task replay

**Effort:** 2-3 weeks

### Unified Chat — Phase 2

Deepen chat system maturity with isolation, real-time sync, and multi-platform support.

- **Multi-user memory isolation** — Per-user engram graph with scoped retrieval. Prerequisite for real multi-tenant semantics beyond RBAC role isolation.
- **Real-time conversation sync** — Live cross-channel streaming via WebSocket push. Telegram replies appear in PWA without refresh.
- **Push notifications** — VAPID keys, service worker push handlers. PWA notifies users of new messages when backgrounded.
- **Slack adapter** — Same bridge pattern as Telegram. New adapter module in chat-bridge service.
- **Conversation history management** — Archive, search, export of old messages. Parallel to consolidation for extended conversation context.
- **Automated VPN/tunnel setup** — Scripted Cloudflare Tunnel and Tailscale configuration. Reduces friction on remote access setup wizard.

**Effort:** 2-3 weeks

### P3: Additional Chat Platforms

Extend chat-bridge adapter pattern. Each adapter is a module in the existing chat-bridge service.

- **Discord** — `discord.py`, channel-based or DM conversations, Docker Compose profile
- **WhatsApp** — Business API, requires approval
- **Matrix/Element** — self-hosted, privacy-focused
- Built-in chat improvements: conversation history sidebar, image/file upload, voice input (Web Speech API), push notifications (Web Push API)

### P3: Advanced Model Routing

- Vision/multimodal routing — detect images in messages, route to vision-capable models
- Long-context detection — route large contexts to models with higher token limits
- Separate chat vs pipeline model defaults
- Chat onboarding — first-run greeting helps users configure providers through conversation

### P3: Demo Platform `[spec]`

**Why:** Self-serve "Try Nova Free" experience for viral growth. Anyone clicks a button on arialabs.ai, gets their own isolated Nova instance for 1 hour — no signup, no install. Converts social media interest into real users before they commit to self-hosting.

**Architecture:** Hybrid — `NOVA_DEMO=true` flag inside Nova activates budget caps, onboarding, session expiry, and feature gating. A separate demo provisioner service on a VPS creates/destroys isolated Docker Compose instances. Traefik handles wildcard routing (`demo-{id}.demo.arialabs.ai`).

**Deliverables:**
- Demo mode in LLM gateway (Redis-backed token budget tracking, cheap model lock)
- Demo mode in orchestrator (session expiry endpoint, write-block after expiry)
- Demo mode in dashboard (onboarding overlay, countdown timer, freeze state, hidden admin features)
- Slimmed `docker-compose.demo.yml` (8 containers, no host ports, Traefik labels)
- Demo provisioner service (FastAPI: instance lifecycle, reaper, rate limiting)
- Demo host infrastructure (Traefik + Let's Encrypt wildcard cert via DNS-01)
- Pre-seeded demo data (engrams, tasks, memory graph)
- Website "Try Nova Free" CTA + provisioning interstitial page

**Cost:** ~$30-40/mo VPS + $0.01-0.08 LLM per session. 5-8 concurrent demos.

**Future:** When multi-tenancy ships, the per-instance provisioner gets replaced with shared-instance tenant isolation. All in-app demo mode work carries forward.

**Spec:** `docs/superpowers/specs/2026-03-29-demo-platform-design.md`
**Plan:** `docs/superpowers/plans/2026-03-29-demo-platform.md`

**Effort:** ~1 week

---

## Future Vision

Brief descriptions only. Implementation deferred until prerequisites complete. Detailed design specs where noted (`[spec]`) are in `docs/roadmap-archive-2026-03.md`.

### MCP Integrations Hub `[spec]`
One-click integration dashboard for self-hosted services and developer tools. `mcp-servers.yaml` config file, auto-discovery on startup, health checks, hot-reload. Priority integrations: Filesystem, Docker, Home Assistant, GitHub, n8n, Brave Search. Bidirectional n8n pattern: n8n handles plumbing, Nova handles intelligence. Devices & Infrastructure dashboard for multi-machine visibility with WoL integration and device-aware inference routing.

### Reactive Event System `[spec]`
Redis Streams event bus with typed events, declarative subscription rules, AI-powered event classification. Cron scheduler with natural language parsing and persistent schedules. Event source adapters: webhook receiver, MQTT/IoT, camera/RTSP, file watcher, API poller, system metrics. Dashboard: event feed, notification center, alert modals, action history. Safety: rate limiting, quiet hours, circuit breakers, confirmation on destructive actions.

### Web IDE & Git Integration `[spec]`
code-server (VS Code in browser) as Docker Compose profile (`--profile ide`). Shares workspace volume with agents — file changes visible instantly. GitHub/GitLab OAuth for clone → branch → work → push → PR workflow. "Open in IDE" buttons on task artifacts. VS Code extension (sidebar, "Ask Nova" command, diff view) as separate distribution.

### Edge Computing `[spec]`
Raspberry Pi deployment profiles based on hardware detection: cloud-only (~800MB RAM, no local models), cloud-first with local memory (~1.2GB), distributed (UI on Pi, compute elsewhere). RDS support for offloading database. Docker Compose overlays per profile.

### Multi-Cloud Deployment `[spec]`
Terraform modules for AWS, DigitalOcean, GCP, Azure, Hetzner. Horizontal scaling of stateless services (orchestrator, gateway, memory-service) behind cloud load balancers. Fixed IPs via Terraform output for service discovery. Docker-based; Kubernetes deferred to SaaS phase.

### SaaS — Nova Cloud `[spec]`
Hosted offering at `nova.arialabs.ai`. Kubernetes deployment (horizontal pod autoscaling, pod disruption budgets), Stripe billing with Free/Pro/Enterprise tiers, email registration + OAuth, GDPR compliance (data export, deletion, cookie consent). Same codebase as self-hosted, gated by `NOVA_SAAS=true`. Prerequisites: managed inference (done) + multi-tenancy (in progress). Estimated infrastructure cost: ~$112/month base, break-even at ~9 Pro subscribers.

### Full Autonomous Loop
Planning Agent reads prior episode memory for proven approaches. Goal similarity matching seeds new plans from past successes. Structured `lessons_learned` engrams written after every goal. Long-horizon goals spanning multiple sessions. Self-assessment across goal history.

### Supernova — Structured Workflow Engine `[spec]`
Evaluate whether Nova should adopt structured development workflows (planning, TDD, systematic debugging, verification gates) as native orchestration-level capability vs prompt-level discipline. Two paths: adopt existing prompt-based workflows, or build native state-machine workflow engine integrating with cortex and engrams.

### Multi-Device Gateway Network
Distributed Nova instances sharing one memory backend via Tailscale. Per-device LLM routing config (e.g., always-on host with cloud-first routing; GPU host with local-only). WoL integration for on-demand GPU inference. (Future — not in scope while Nova is dev-only on a single host.)

### Domain Restructuring
`arialabs.ai` as company website (landing + Nova product pages + docs at `/nova/docs/`). `nova.arialabs.ai` as private live instance behind Cloudflare Access with email auth. Docs migration with redirects from current URLs.

### Hierarchical Memory Transformer
Small fine-tuned transformer (~7B) that learns to BE the memory system — compression, storage, retrieval, reconstruction end-to-end. Replaces template reconstruction and potentially the Neural Router. High risk, high reward. Requires months of Engram Network operation for training data.

### Nova Browser — AI-Native Browsing
Privacy-first, AI-native browser experience integrated into Nova. Not a browser with AI bolted on — an AI platform where browsing is a first-class capability. Zero telemetry, no logging. Nova's agents can navigate sites, click, inspect network traffic, debug frontend, screenshot, and record sessions natively.

**Open architectural question (revisit post-platform-completion):**
- **Desktop app + embedded browser pane** — Electron/Tauri, browser as a tab/pane within Nova. Lightest lift, but users still need a separate daily browser.
- **Full Chromium shell** — Nova IS the browser (like Arc/Brave). Most ambitious, most differentiated, highest maintenance burden.
- **Split-pane hybrid** — Nova panels + browser side by side in one window. AI sees what you see in real time. No context switching.

Key capabilities: page annotation/highlighting, network inspector with AI analysis, DOM-aware AI assistance, session recording/replay, agent-driven browsing (user watches or takes over), built-in tracker/ad blocking. Supersedes the P2 Browser Automation (Computer Use) roadmap item — that becomes a subset of this vision.

Prerequisites: all current roadmap items complete. This is the capstone feature.

---

## Platform Review Findings (2026-03-26)

Comprehensive 5-discipline review (architecture, backend, frontend, security, testing). Full spec with per-finding remediation: `docs/specs/2026-03-26-platform-review-findings.md`.

### ✅ P0 — Delivered 2026-03-26
| ID | Finding | Status |
|---|---|---|
| SEC-2 | Reindex endpoint missing auth — added `AdminDep` to both handlers | ✅ |
| SEC-3 | SSRF in `web_fetch` — added `validate_url()` + per-hop redirect validation | ✅ |
| SEC-4 | Trusted proxy header — only trust header when direct IP is in trusted CIDRs | ✅ |
| ARCH-4 | Embedding cache L2 — added `AND model = :m` to both lookups | ✅ |
| BE-1 | MCP registry — added `asyncio.Lock` on mutations, `list()` snapshots on reads | ✅ |

### ✅ P1 — Delivered 2026-03-27

**Delivered in commits `4c52e28` (bulk P1 fixes) and follow-up BE-4 security logging.**

| ID | Finding | Status |
|---|---|---|
| SEC-1 | `REQUIRE_AUTH` defaults to false — `.env.example`, docker-compose defaults, and `.env` all set to `true` | ✅ |
| SEC-7 | WebSocket no connection limit — added global (100) + per-IP (10) limits, history cap (200) | ✅ |
| ARCH-1 | Dead letter queue unbounded — capped at 10k | ✅ |
| ARCH-2 | Non-atomic SADD+LPUSH in enqueue_task — replaced with atomic Lua script | ✅ |
| ARCH-6 | Ingestion semaphore held over full process — switched to `create_task` for concurrency | ✅ |
| BE-2 | Dead `pass` block in validate_invite — removed | ✅ |
| BE-3 | N+1 queries in list_recommendations — single query | ✅ |
| BE-4 | Auth security bypasses logged at nothing — WARNING logs on deny-list hits, deactivated/expired accounts, deny-list additions | ✅ |
| FE-1 | Conversation delete fires immediately — added confirmation dialog | ✅ |
| FE-2 | API key save failure silent — errors surfaced to UI | ✅ |
| FE-3 | Service restart failure silently swallowed — errors surfaced to UI | ✅ |

### P2 — Fix this sprint
| ID | Finding | Effort |
|---|---|---|
| ARCH-3 | `working_memory_slots` never cleaned up — unbounded growth | 2 hours |
| ARCH-5 | `intel:new_items` queue written but never consumed — dead code. **Addressed in P1: Autonomous Loop Activation, Tier 3.** | 1 hour |
| ARCH-7 | Orphaned comments/engram references after parent deletion | 2 hours |
| SEC-5 | Google OAuth bypasses invite-only registration | 1 hour |
| SEC-6 | No rate limiting on login/register — brute force possible | 2 hours |
| FE-4 | Modal missing `role="dialog"`, focus trap — accessibility gap across all dialogs | 2 hours |
| FE-6 | MCP reload spinner shared across all server cards | 15 min |
| FE-7 | Role change fires immediately — no confirmation on privilege change | 30 min |
| TEST-1 | No memory/engram tests — zero coverage of the central memory system | 4 hours |
| TEST-2 | No MCP server CRUD or introspect tool tests | 2 hours |
| TEST-3 | No JWT auth flow tests — login/register/refresh untested | 3 hours |

### P3 — Next cycle
| ID | Finding | Effort |
|---|---|---|
| ARCH-8 | `usage_events` and `messages` tables need partition strategy | 1 day |
| SEC-8 | Auto-generate admin secret at setup | 2 hours |
| FE-5 | Chat input accessibility (send button, textarea labels) | 1 hour |
| TEST-4 | Cortex integration tests (zero coverage) | 4 hours |
| TEST-5 | Fix weak/fake test patterns (artifacts no-op, soft asserts, hardcoded skips) | 3 hours |
| TEST-6 | Test isolation fixes (bulk delete pollution, state leaks, hardcoded URLs) | 2 hours |

---

## Known Gaps & Deferred Work

### Active Technical Debt

**Pipeline — resolved (2026-03-25):**
- ~~Agent output schemas not validated~~ — Pydantic models for all 5 stages, validated in `think_json()` (`schemas.py`)
- ~~Error context destroyed on failure~~ — stack traces, LLM messages, structured error_context JSONB preserved (migration 044)
- ~~Task state machine unvalidated~~ — CAS transitions via `state_machine.py`, terminal state protection
- ~~Recovery strategy uses substring matching~~ — structured error classification by type, exponential backoff, substring matching as fallback
- ~~Heartbeat loop swallows all exceptions~~ — failure counter, asyncio.Event cancellation after 3 failures
- ~~Parallel group exceptions silently dropped~~ — critical agents (guardrail, code_review) now fail pipeline on crash

**Pipeline — remaining:**
- Prompt injection in pipeline — user input interpolated directly into agent prompts (XML boundaries not yet added)
- Checkpoint save retry — not yet implemented

**Infrastructure:**
- No circuit breaker for LLM providers — failed providers not routed around
- DB connection pool has no idle validation — stale connections after Postgres restarts undetected
- Admin secret default (`nova-admin-secret-change-me`) accepted without warning in production
- Dead letter queue grows unbounded — no TTL, no cleanup, no archival
- Episodic memory partitions hardcoded through 2026-04 — need auto-creation
- `IngestionSourceType` contract drift — `nova-contracts/engram.py` enum lists 8 types (`chat`, `pipeline`, `tool`, `consolidation`, `cortex`, `journal`, `external`, `self_reflection`) but memory-service `_map_source_type_to_kind` runtime handles 11 (adds `intel`, `knowledge`, `screenpipe`). Producers (intel-worker, knowledge-worker, screenpipe-bridge) push strings not in the formal contract. Either tighten the enum to match runtime reality, or formally support custom `source_type` strings and document the extension path so future workers (e.g. a homegrown screenpipe replacement) know the contract surface.

**Cortex — partially resolved (2026-03-25, updated 2026-03-28):**
- Partial test coverage — `test_cortex_goals.py` covers cost tracking + goal schema. Thinking loop tests still needed.
- ~~Dispatches tasks without checking results~~ — TRACK phase polls orchestrator, reads results
- ~~Hardcoded outcome scores~~ — actual measurement based on task status (0.8/0.6/0.2/0.1/0.5)
- ~~`progress` field never updated~~ — updated based on iteration count vs max_iterations
- ~~Cost tracking pipeline broken~~ — 3-gap fix shipped 2026-03-28
- Goals stuck in skip loop — root cause analyzed, fix planned in P1: Autonomous Loop Activation, Tier 1

### Deferred Features

| Feature | Notes |
|---|---|
| **Sandbox tiers** | Only `workspace` active. `isolated` (ephemeral container), `nova` (self-config), `host` (unrestricted) designed but not implemented. `shell_sandbox` config field exists but not read by tool code. |
| **End-to-end tool testing** | list_dir, read_file, write_file, run_shell, search_codebase, git workflow, path traversal, denylist — not yet validated with integration tests |
| **Post-pipeline agents** | Documentation, Diagramming, Security Review, Memory Extraction agents designed in Quartet spec but not built |
| **Default pods** | Quick Reply, Research, Code Generation, Analysis designed but only Quartet shipped |
| **ClaudeCode provider** | Spawn `claude -p` subprocess for zero API cost via Claude Max subscription. Designed, not implemented. |
| **Brain 2D Graph View** | Obsidian-style 2D Canvas graph view for Brain page — simple dots/lines, no WebGL, can render all nodes without the 2K cap. Toggle between Galaxy (3D) and Graph (2D) views. |
| **Web Push notifications** | Task completion push via PWA service worker |
| **Key-level model restrictions** | `sk-nova-*` keys scoped to specific providers |
| **Multi-model A/B testing** | Run two models on same subtask, Evaluation Agent picks better output |
| **Collaborative goals** | Multiple users contributing context to shared goals (requires multi-tenancy + SaaS) |

---

## Competitive Landscape

> Updated 2026-03-25. Sourced from analysis of OpenClaw, CrewAI, LangGraph, OpenHands, AutoGPT, BabyAGI, smolagents, and the OpenAI Agents SDK.

### What Nova Has That Others Don't

| Capability | Description |
|---|---|
| **Engram Network** | Graph-based cognitive memory with spreading activation, consolidation cycles, entity resolution, contradiction detection, and neural re-ranker. Far ahead of any competitor's memory system. |
| **Quartet Pipeline** | 5-stage safety chain with guardrails on every task. Most platforms have no built-in safety. |
| **Cortex** | Autonomous brain with goals, 5 cognitive drives, budget tracking. No competitor has a comparable self-directed planning layer. |
| **Knowledge Acquisition** | Intel-worker + knowledge-worker for autonomous information gathering. Unique capability. |
| **Multi-provider routing** | 27+ providers including zero-cost subscription-based, with local/cloud strategies and intelligent classification. |
| **Recovery service** | Dedicated backup/restore that survives other service failures. |
| **Full admin dashboard** | 20-page production React UI with chat, tasks, memory graph, goal management, inference management. |

### Where Nova Lags

| Gap | Competitor Reference | Nova's Path |
|---|---|---|
| Self-awareness | OpenClaw: `openclaw doctor` + self-inspection | P0: Self-Introspection |
| Pipeline reliability | Unvalidated outputs, lost error context | P0: Pipeline Reliability |
| Browser automation | OpenClaw: CDP Chromium for autonomous web browsing | P2: Computer Use |
| Skill ecosystem | OpenClaw: 13,700+ community skills via ClawHub | P1: Skills & Rules |
| Messaging platforms | OpenClaw: 20+ platforms vs Nova's 2 | P3: Chat Platforms |
| Onboarding simplicity | `openclaw onboard --install-daemon` (single command) | P2: Nova CLI |
| Mobile/device integration | OpenClaw: iOS, Android, macOS native apps | Future |
| Voice I/O | OpenClaw: wake words, ElevenLabs TTS | Future |
| Agent-rendered UI | OpenClaw: Live Canvas interactive workspaces | Future |

### Key Takeaway

Nova doesn't need to replicate OpenClaw's breadth. The priority focus:
1. **Pipeline reliability** — autonomous operation must be trustworthy
2. **Self-awareness** — agents that can't diagnose themselves can't direct themselves
3. **Skill ecosystem** — extensibility without code changes

Those three close the biggest capability gap. Nova's cognitive architecture (engrams, cortex, quartet safety) is genuinely ahead — the gap is in utility and reliability, not intelligence.

### Market Context

- AI agent market: $7.84B (2025) → projected $52.62B by 2030 (46.3% CAGR)
- MCP becoming standard for tool integration — adopted by OpenAI, Anthropic, Cursor, Replit, VS Code
- Guardrails becoming legally mandatory (California SB 243/AB 489, Singapore Model AI Governance) — Nova's built-in Guardrail Agent is a competitive advantage
- Key research: Andrew Ng agentic patterns (GPT-3.5+agentic 95.1% vs GPT-4 zero-shot 67.0%), Anthropic "Building Effective Agents", CodeAct (code as action space, 20%+ improvement)

---

## Reference

### Key Design Specs (in archive)

| Topic | Archive Section |
|---|---|
| Pipeline reliability fixes | Phase 4c |
| Skills & Rules system (schema, API, integration) | Phase 5c |
| Nova SDK, CLI, TUI (full command tree, examples) | Phase 6c |
| Self-introspection tools and safety | Phase 7a |
| Supernova workflow engine evaluation | Phase 7b |
| MCP integrations hub (homelab, dev, infra) | Phase 8b |
| Browser automation (computer use) architecture | Phase 9 |
| Reactive event system | Phase 9a |
| Web IDE & git integration | Phase 9b |
| Edge computing deployment profiles | Phase 10 |
| Multi-cloud Terraform modules | Phase 11 |
| SaaS architecture and billing | Phase 14 |

### Research References

- Anthropic, "Building Effective Agents" — anthropic.com/research/building-effective-agents
- Andrew Ng agentic design patterns — GPT-3.5+agentic (95.1%) vs GPT-4 zero-shot (67.0%)
- CodeAct — arxiv.org/abs/2402.01030 (code as unified action space, ICML 2024)
- ReAct — arxiv.org/abs/2210.03629 (reasoning + acting)
- "Agents That Matter" — arxiv.org/abs/2407.01502 (cost-accuracy tradeoff)
- Generative Agents — arxiv.org/abs/2304.03442 (memory + reflection)
- Voyager — arxiv.org/abs/2305.16291 (skill library + self-verification)
