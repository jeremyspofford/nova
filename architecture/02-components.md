# 02 — Component Inventory

> **Audit date:** 2026-07-05. Endpoint counts were measured with a
> multiline-tolerant scan of route decorators; line counts exclude
> `.venv`/`__pycache__`. Status is evidence-based: **working** = healthy at
> runtime + test coverage; **partial** = runs but has known gaps;
> **unverified** = no runtime exercise within this audit.

Legend: ✅ working · 🟡 partial · ⚪ unverified · 🪦 dead

---

## 1. Orchestrator — `orchestrator/app/` (128 files, 32,015 loc) ✅

The hub. Owns Postgres migrations and most platform state. Everything else is
a satellite.

### Entry point — `main.py` (579 loc)
- Lifespan: DB init + 89 SQL migrations → seeds (default tenant, admin user,
  tool permissions, platform secrets from `.env`, config sync) → feature-flag
  cache warm → background tasks.
- Background tasks (verified at `main.py:406-430`): MCP server loading
  (non-blocking), queue worker, stale-task reaper, effectiveness loop, chat
  scorer, auto-friction subscriber, GitHub poller, capability approval worker.
- 16 routers registered (`main.py:563-579`).

### API routers

| Router | File (loc) | Endpoints | Surface |
|---|---|---|---|
| core | `router.py` (1,668) | 45 | agents CRUD+chat (blocking/SSE), conversations, simplified `/api/v1/chat`, API keys, usage, sandbox, skills/rules, OpenAI-compat proxy (`/v1/models`, `/v1/chat/completions`) |
| pipeline | `pipeline_router.py` (1,272) | 37 | task submit/list/get/cancel/clarify/review, findings/reviews/sessions/artifacts, pods CRUD, mcp-servers CRUD, agent-endpoints (A2A) CRUD, stats, SSE notifications |
| auth | `auth_router.py` (766) | 26 | login/JWT/refresh, Google OAuth, users CRUD, invites, RBAC roles, guest access |
| capabilities | `capabilities/router.py` | 20 | consent rules, credentials (AES-256-GCM), approvals, audit query, watched repos |
| quality | `quality_router.py` (837) | 17 | AI-quality scores, benchmark runs, quality-loop sessions, config snapshots |
| goals | `goals_router.py` (581) | 16 | goal CRUD, maturation approve/reject, schedules (cron), decomposition views |
| knowledge | `knowledge_router.py` (622) | 15 | knowledge sources CRUD, crawl-log ingest (proxies for knowledge-worker) |
| ingestion | `ingestion_router.py` | 4 | generalized external-source HTTP ingestion → memory queue (per-source tokens, rate limit, denylist, backpressure) |
| intel | `intel_router.py` (657) | 14 | feeds CRUD, content ingest, recommendations, feed status |
| friction | `friction_router.py` (381) | 9 | friction log CRUD + screenshots + "Fix This" task dispatch |
| flags | `feature_flags_router.py` (403) | 8 | admin CRUD + audit + public allowlisted subset (`/public`, no auth) |
| secrets | `secrets_router.py` (74) | 4 | platform secrets list/upsert/revoke/resolve (SEC-006a) |
| webhooks | `webhooks_router.py` (244) | 3 | GitHub webhook receive + CI-triage stimulus emit |
| workspace | `workspace_router.py` (49) | 1 | workspace file listing |
| health | `health.py` | 2 | `/health/live`, `/health/ready` |

### Pipeline engine — `pipeline/`
- `executor.py` (2,014 loc) — stage driver, checkpointing, retries, heartbeat,
  notifications, cost accounting. **Largest single file in the repo.**
- `agents/` — `base.py` (PipelineState, `should_agent_run()`), `context.py`,
  `task.py`, `guardrail.py`, `code_review.py`, `critique.py`, `decision.py`,
  `post_pipeline.py`.
- `state_machine.py` — CAS status transitions.
- `complexity_classifier.py` + `complexity_model_map.py` + `stage_model_resolver.py`
  — route stages to models by task complexity.
- `prompt_safety.py` — injection defenses; `checkpoint.py`; `schemas.py`;
  `tools/` — MCP registry + stdio/HTTP clients.

### Chat agent runtime — `agents/runner.py` (1,343 loc)
`run_agent_turn()` / `run_agent_turn_streaming()` / `run_agent_turn_raw()`;
memory context injection (`_get_memory_context`, inject vs tools mode),
self-knowledge + sandbox context builders, tool loop (`_run_tool_loop`),
source extraction (memory files + web pages surfaced to UI), exchange →
ingestion queue, memory prewarm.

### Tools — `app/tools/` (13 modules, ~70 tools)
`memory_tools` (what_do_i_know, search_memory, recall_topic, read_memory,
remember), `web_tools` (search/fetch), `code_tools` (file I/O), `git_tools`,
`github_tools` (self-mod), `github_external_tools`, `browser_tools` (navigate/
snapshot/act/submit via browser-worker), `intel_tools`, `config_tools`,
`platform_tools`, `diagnosis_tools`, `introspect_tools`, `sandbox.py`
(workspace/home/isolated tiers; `root` tier removed SEC-001).

### Cross-cutting infra
`config.py`, `db.py` (asyncpg pool + migration runner), `store.py` (redis),
`auth.py`/`jwt_auth.py`/`oauth.py`/`roles.py`/`guest.py`/`trusted_network.py`,
`secrets_store.py` (AES-256-GCM envelope under HKDF), `audit.py`,
`config_sync.py`/`config_demotion.py` (env→DB migration of runtime keys),
`model_resolver.py`/`model_classifier.py`, `usage.py`, `users.py`,
`conversations.py`, `activity.py`, `stimulus.py`, `quality_scorer.py`.

### Background quality/scoring subsystems
- `quality_loop/` — pluggable self-tuning loops; **only one registered loop**
  (RetrievalTuningLoop) via `registry.py`.
- `effectiveness.py`, `chat_scorer.py`, `auto_friction.py`, `polling_worker.py`
  (GitHub), `capabilities/approval_worker.py`, `queue.py`, `reaper.py`.

**Deps:** postgres, redis (db2), llm-gateway, memory-service, nova-contracts,
nova-worker-common.
**Risks:** three files >1,300 loc (`executor.py` 2,014, `router.py` 1,668,
`runner.py` 1,343) carry most of the platform's behavior.

---

## 2. LLM Gateway — `llm-gateway/app/` (31 files, 5,594 loc) ✅

- `router.py` — Nova-native `/complete`, `/stream`, `/embed` (5 endpoints).
- `openai_router.py` — OpenAI-compatible `/v1/chat/completions`, `/v1/models`,
  `/v1/embeddings` (3 endpoints).
- `registry.py` (792 loc) — provider construction, model→provider resolution,
  routing strategy (`local-first|local-only|cloud-first|cloud-only` from Redis),
  model sync loops (Ollama/vLLM/LM Studio), embed-provider override
  (`llm.embed_provider`), provider catalog for the dashboard.
- `providers/` (13 impls): `litellm_provider` (cloud aggregator), `ollama`,
  `lmstudio`, `vllm`, `sglang`, `llamacpp`, `local_inference` (generic
  OpenAI-compat), `openai_compatible`, `remote`, `gemini_adc`,
  `chatgpt_subscription` (codex token), `ollama_cloud_fallback`, `fallback`
  (chain-of-responsibility). `claude_subscription_provider` **no longer exists**
  (TODOS.md reference is stale).
- Support: `rate_limiter.py` (Redis sliding window), `response_cache.py`
  (300s TTL), `discovery.py` (Ollama model discovery), `tier_resolver.py`
  (local/cloud tiering), `wol.py` (Wake-on-LAN for a remote Ollama box),
  `editor_tracker.py`, `openai_compat.py`.

**Deps:** redis (db1), provider APIs. Reads platform secrets at module load
via `nova_worker_common.platform_secrets` (sync, because adapters capture
tokens at construction) and **hot-reloads them at runtime** (FU-009, shipped
2026-07-10): the orchestrator publishes on `nova:secrets:invalidate` after
every dashboard key change; the gateway re-resolves, recomputes the env
overlay (`app/secrets_runtime.py`), re-keys Gemini/ChatGPT in place, rebuilds
fallback chains, and lifts credential-guard cooldowns — no restart.

---

## 3. Memory Service — `memory-service/app/` (16 files, 2,299 loc) ✅

- `memory_router.py` — 12 endpoints on the neutral API: `/api/v1/memory/`
  `context | write | mark_used | feedback | provenance | stats | items/{id} |
  explain | consolidate | reindex | delete` (+ health).
- `backends/base.py` — `MemoryBackend` ABC: required `write, context,
  mark_used, feedback, provenance, stats`; optional `explain, consolidate,
  reindex, delete, read_item`.
- `backends/okf/` — the only built-in backend (931 loc total):
  - `store.py` (399) — bundle layout (`index.md`, `log.md`, `journal/`,
    `topics/ people/ projects/ preferences/ sources/`, `.nova/`), frontmatter
    read/write, `[[link]]` extraction, root-index maintenance.
  - `index.py` (203) — BM25 index over `.nova/index.json`, mtime-drift
    self-heal, per-file score accumulator (usage feedback).
  - `backend.py` (329) — write routing (explicit OKF metadata → concept file;
    else journal digest), context assembly under a char budget (root index
    always included), retrievals log (`.nova/retrievals.jsonl`), journal
    retention backstop (45-day archive).
- `ingestion.py` — BRPOP consumer of `memory:ingestion:queue` (redis db0)
  routing payloads to the active backend.
- **No database.** No SQLAlchemy. (CLAUDE.md's "memory-service uses SQLAlchemy
  async" is stale — see 05.)

**Design note:** the orchestrator can be pointed at any external provider
implementing this API via `memory.provider_url` — the backend interface and
the HTTP contract are the product's memory plug-point.

---

## 4. Cortex — `cortex/app/` (36 files, 5,856 loc) 🟡 working, gaps known

- `loop.py` — BRPOP-driven thinking loop; adaptive interval (30s active →
  1,800s idle, exponential backoff, error backoff); gated on orchestrator
  config `features.brain_enabled` (default **off**).
- `cycle.py` (~1,040 loc) — PERCEIVE → EVALUATE → PLAN → ACT → REFLECT (flow
  in 01); zombie-goal sweep every 100 cycles; approach-dedup (blocked
  approaches force a re-plan); background task monitor collection.
- `drives/` — 7 drives, each `assess(ctx) → DriveResult(urgency)`: `serve`
  (goal work — the main path), `improve`, `maintain` (health + goal triage),
  `learn`, `reflect`, `quality`, `ci_triage` (also a stimulus fast-path).
- `maturation/` — **wired** (verified `cycle.py:610-645`, `maintain.py:34`):
  `triage.py` (complexity classify) → `scoping.py` → `speccing.py` → human
  review gate → `building.py` (decomposition into goal_tasks / child goals)
  → waiting → `verifying.py` (aggregator + criteria). `commands.py` shared
  helpers.
- Support: `budget.py` (daily USD cap, tier published to gateway), `journal.py`
  (goal journals + user replies), `reflections.py`, `memory.py` (perceive
  via memory-service), `scheduler.py` (cron goal schedules), `stimulus.py`
  (Redis queue + emit), `task_monitor.py`/`task_tracker.py`, `prompt_safety.py`,
  `router.py` (9 endpoints: state, cycles, goals views, budget, stimulus).

**Test coverage exists** (contrary to the 2026-07-03 audit): `test_cortex_goals/
loop/reflections`, `test_maturation_{triage,scoping,speccing,approve,lifecycle,
verifying}`, `test_decomposition_{simple_path,lifecycle,speccing,failure_recovery}`,
`test_drive_scheduling`, `test_capability_cortex_wiring`, `test_verification_aggregator`.

**Real remaining gaps** (from TODOS.md, still true in code):
- Learning from failures: reflections are written but never queried back into
  PLAN prompts.
- No `request_human_checkpoint` flow (CAPTCHA/email-verification resume).

---

## 5. Chat API — `chat-api/app/` (6 files, 995 loc) ✅

WS endpoint `/ws/chat` (+ health, + test UI at `/`). `websocket.py` handles
auth (admin secret or API key validated against orchestrator), forwards to
orchestrator streaming, relays SSE frames to WS. `queue.py`/`drain.py`/
`session.py` — backpressure and session bookkeeping. Redis db3.

**Consolidation candidate** — see 06: orchestrator already speaks SSE; this
service exists to give external clients a WS dialect.

---

## 6. Recovery — `recovery-service/app/` (20 files, 3,117 loc) ✅

- `routes.py` (19 endpoints): backups CRUD + restore, factory reset (PRIV-003
  scope incl. OKF memory + friction screenshots), service list/restart/logs,
  env whitelist editor (refuses secret-bearing keys), troubleshoot.
- `docker_client.py` — SDK via socket-proxy (allowlisted); `compose_client.py`
  — compose CLI on the raw socket (documented trust split, SEC-006b).
- `inference/` — bundled-inference lifecycle: `controller.py` (start/stop
  compose profiles, writes `nova:config:inference.url` on start, clears on
  stop), `hardware.py` (GPU detect → `data/hardware.json`), `model_search.py`,
  `routes.py`.
- `scheduler.py` — periodic backup checkpointer; `backup.py` (pg_dump +
  memory-bundle tarball); `factory_reset.py`; `env_manager.py`.
- Explicit admin credentials required for destructive endpoints (fixed
  2026-07-01 after the trusted-network bypass incident).

**Note:** `factory_reset.py:130` still truncates legacy table
`embedding_cache` (harmless; see 05).

---

## 7. Ingestion workers

### intel-worker — `intel-worker/app/` (12 files, 576 loc) ✅
Polls RSS / Reddit JSON / page-change / GitHub trending+releases on per-feed
intervals; pushes items via orchestrator `/api/v1/intel/*`; queues digests to
memory ingestion; health-only HTTP server. Redis db6.
**Consolidation candidate** (06): 576 loc of pure poller with no state of its
own — all state lives in orchestrator tables.

### knowledge-worker — `knowledge-worker/app/` (17 files, 1,530 loc) ⚪ (profile off on audited host)
LLM-guided crawler: seeds from `knowledge_sources`, relevance-scores pages via
gateway `/complete`, GitHub API extraction, encrypted credentials, page cache.
Redis db8. Tests exist (`test_knowledge.py`).

---

## 8. Interaction workers

### browser-worker — `browser-worker/app/` (6 files, 507 loc) ✅ (profile `browser`)
Playwright automation: `POST /sessions`, `/sessions/{id}/navigate`,
`/snapshot` (numbered accessibility tree), `/act` (click/type/select),
`GET /sessions`. Persistent per-domain profiles under `data/browser-profiles`
so logins survive restarts. Consumed exclusively by orchestrator
`browser_tools.py`. Redis db11.

### voice-service — `voice-service/app/` (8 files, 592 loc) ✅ (profile `voice`)
STT/TTS proxy — **OpenAI only** (Whisper + TTS). Deepgram/ElevenLabs removed
2026-07-02 (`9f031ba`), but compose still passes `DEEPGRAM_API_KEY` /
`ELEVENLABS_API_KEY` env vars (dead — see 05). Dashboard proxies `/voice-api`.

---

## 9. Dashboard — `dashboard/src/` (188 files, 38,306 loc) ✅

- **32 pages:** Chat, Tasks, Pods, Goals (+ maturation detail/badges/stages),
  Friction, Keys, Users, Skills, Rules, MCP, Models, Sources, Usage, AIQuality,
  AuditLog, Recovery, Editor(s), Integrations, AgentEndpoints,
  PendingApprovals, Login/Invite/Expired, About, Settings + subtrees
  (chat/, dev/, editors/, onboarding/, quality/, settings/).
- **33 settings sections** (`pages/settings/`): Account, AdminSecret,
  Appearance, AutoApproveRules, Brain,
  ConnectedServices, ContextBudget, Debug, DeveloperResources, Editor,
  FeatureFlags, GoalCreation, GuestAccess, Keys, LLMRouting, LocalInference,
  Maintenance, MemoryProvider, Notifications, PipelineModels, ProviderStatus,
  Recovery, RemoteAccess, Rules, Sandbox, SelfMod,
  Skills, ToolPermissions, TrustedNetworks, Users, Vaultwarden.
- 38 shared UI components (`components/ui/`); TanStack Query (staleTime 5s);
  `apiFetch<T>()` in `src/api.ts`; nginx proxies `/api`, `/v1`,
  `/recovery-api`, `/cortex-api`, `/voice-api`.
- `useFeatureFlag<T>()` against the public flags endpoint.

**Risk:** no typed contract with the backend (hand-written TS types can drift
from Pydantic models silently).

---

## 10. Shared libraries

### nova-contracts (11 files, 1,213 loc) ✅
Pydantic-only API contracts: `chat.py`, `llm.py`, `memory.py`,
`orchestrator.py`, `tier.py`, `logging.py`, plus the feature-flag SDK
(`feature_flags.py`, `_http.py`, `_pubsub.py`, `_testing.py`).

### nova-worker-common (16 files, 955 loc) ✅
`service_auth.py` (TrustedNetworkMiddleware — note the factory-reset incident
history), `admin_secret.py`, `platform_secrets/` (sync fetch for boot-time
consumers), `content_hash.py`, `url_validator.py`, `credentials.py`.

---

## 11. Ops & meta files

| Item | Status | Note |
|---|---|---|
| `docker-compose.yml` (985 lines) | ✅ | 25 service definitions (12 always-on + 13 profile-gated); contains a stale "inference is NOT bundled" comment block (05) |
| `docker-compose.gpu.yml` | ✅ | NVIDIA overlay for bundled inference |
| `Makefile` | ✅ | dev/build/test/backup/prune targets; tests run via `uv run --with …` |
| `install` (36 KB) | ⚪ | interactive wizard (mode/providers/bundled/remote/admin/summary) — rewritten 2026-07-03, unverified end-to-end |
| `start`, `uninstall`, `dev` | ✅/⚪ | boot, removal (preview-first), dev prereq checker |
| `scripts/` | mixed | `bootstrap.sh`, `install.sh`, `backup.sh` (**not executable — `make backup` fails**, verified), `restore.sh`, `detect_hardware.sh`, `setup-remote-ollama.sh` |
| `tests/` (~90 files, 16,360 loc) | ✅ | integration suite against live services; see run results in 05 |
| `benchmarks/` | 🟡 | memory-retrieval benchmark harness (LLM-judge, precision@5/MRR); predates the single-backend reality — review for OKF fit |
| `.github/workflows/` | ✅ | `nova-ci.yml`, `deploy-website.yml` |
| `website/` | ✅ | Astro/Starlight marketing + docs (arialabs.ai) |
| `workspace/` | 🪦 | 21 tracked agent-generated junk files (see 05) |
| `docs/` | 🟡 | large historical archive with stale content (see 05) |
| `PROMPT.md`, `UBIQUITOUS_LANGUAGE.md`, `DESIGN.md`, `TODOS.md` | 🟡 | meta docs; TODOS.md partially stale (maturation/claude-subscription entries) |
