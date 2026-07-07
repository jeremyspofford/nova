# 03 — Data Model

> **Audit date:** 2026-07-05. Table lists were extracted from
> `orchestrator/app/migrations/*.sql` (89 files, `001`…`092`, **gap at 084** —
> intentional or lost, flag for renumber-awareness) and cross-checked against
> the live database (`pg_tables`).

---

## 1. PostgreSQL (owner: orchestrator; consumers: cortex, recovery)

Single database `nova`. No ORM in the orchestrator/cortex (raw asyncpg);
migrations are plain versioned SQL run idempotently at orchestrator startup
and tracked in `schema_migrations`.

### 1a. Table inventory by domain (62 tables from migrations)

**Execution (pipeline)**
- `tasks` — the work unit. Key columns: `id` UUID PK, `user_input`,
  `pod_id→pods`, `goal_id→goals`, `user_id→users`, `status` (11-state machine),
  `current_stage`, `checkpoint` JSONB (full pipeline state for crash resume),
  `retry_count`/`max_retries`, `output`, `error`, `summary`, `total_cost_usd`,
  `queued_at/started_at/completed_at`, `metadata` JSONB.
- `pods` — execution profiles: `name` (routing key), `routing_keywords[]`,
  `default_model`, `max_cost_usd`, `max_execution_seconds`,
  `require_human_review`, `escalation_threshold`, `sandbox`
  (workspace|home|isolated), `metadata`.
- `pod_agents` — per-pod stage config (position + role = execution order).
- `agent_sessions`, `guardrail_findings`, `code_reviews`, `artifacts` —
  per-stage execution records FK'd to tasks.
- `pipeline_training_logs` — stage I/O capture for future tuning (written and
  read by quality code; currently 0 rows on audited host).

**Autonomy (cortex)**
- `goals` — `title`, `description`, `status` (active|paused|completed|failed),
  `maturation_status` (triaging|scoping|speccing|review|building|waiting|
  verifying|NULL), `complexity`, `current_plan` JSONB (plan + pod hint +
  ci metadata + consecutive_skips), `decomposition` JSONB, schedule linkage,
  `check_interval_seconds`, `last_checked_at`.
- `goal_tasks` — goal↔task links for decomposed work; `goal_iterations`,
  `goal_verifications` (verify-phase evidence), `goal_schedules` folded into
  goals/scheduler (cron expressions; seeded "Nightly memory curation" @ 03:00
  via migration 090).
- `cortex_state` (singleton row: cycle_count, last_cycle_at),
  `cortex_reflections`, `cortex_poll_state`, `cortex_watched_repos`.

**Identity & access**
- `tenants`, `users` (email, password_hash, is_admin, role, provider),
  `refresh_tokens`, `invite_codes`, `api_keys` (SHA-256 of `sk-nova-*`),
  `rbac_audit_log`, `audit_log` (⚠️ write-only — inserted, never queried),
  `guest` access via config not tables.

**Capability platform (SEC/consent)**
- `capability_credentials` (AES-256-GCM), `capability_audit` (hash-chained),
  `capability_credential_audit`, `consent_rules`, `approval_requests`
  (human-in-the-loop queue + execute queue, migration 080),
  `github_webhooks`, `selfmod_prs`.
- `platform_secrets` (SEC-006a: provider keys, OAuth client secret, self-mod
  PAT — encrypted under HKDF subkey of `CREDENTIAL_MASTER_KEY`).

**Configuration**
- `platform_config` (JSONB KV — authoritative runtime config, synced to Redis
  db1 `nova:config:*`), `platform_config_audit`.
- `feature_flags`, `feature_flag_audit` (+ actor ip/UA/request-id, migration 085).
- `mcp_servers`, `agent_endpoints` (A2A/ACP delegation targets),
  `skills`, `rules`, `tool_permissions` (seeded; minimal default toolset,
  migration 086).

**Chat & product surface**
- `conversations`, `messages`, `comments` (task discussion threads),
  `activity_events` (dashboard feed), `friction_log` (+ file-based screenshots
  under `data/friction-screenshots/`), `usage_events` (token/cost accounting),
  `conversation_outcomes` (⚠️ write-only — see 05).

**Intel & knowledge**
- `intel_feeds`, `intel_content_items` (+ `_archive`), `intel_recommendations`,
  `intel_recommendation_sources`, `intel_recommendation_memories` (renamed from
  `_engrams`, migration 092).
- `knowledge_sources`, `knowledge_crawl_log` (columns still named
  `engrams_created`/`engrams_updated` — legacy naming), `knowledge_credentials`,
  `knowledge_credential_audit`, `knowledge_page_cache`.

**Quality**
- `quality_scores`, `quality_benchmark_runs`, `quality_config_snapshots`,
  `quality_loop_sessions`.

### 1b. ⚠️ Legacy orphan tables (live DB only — no migration creates them, no code reads them)

Created by the **removed** pre-OKF memory system (memory-service used to run
its own SQLAlchemy `schema.sql`); left behind in the live DB:

| Table | Rows (audited host) | Only remaining code reference |
|---|---|---|
| `engrams` | 5 | none |
| `engram_edges`, `engram_archive` | — | none |
| `working_memory_slots` | — | none |
| `embedding_cache` | — | `recovery-service/app/factory_reset.py:130` (truncate list) |
| `consolidation_log` | — | none |
| `retrieval_log` | — | none (migration 091's comment "retrieval_log stays — mark-used feedback still records usage signals" is **already false**; OKF logs to `.nova/retrievals.jsonl`) |
| `sources` | — | none |
| `neural_router_models` | — | none — **and migration 091 dropped it, yet it exists live** → recreated after 091 ran (old image or backup restore). Evidence of schema drift between migrations and reality. |

**Recommended fix (see 06):** one cleanup migration `093_drop_legacy_memory_tables.sql`
dropping all nine, plus removing the `embedding_cache` entry from factory reset.

### 1c. Dropped by migration (already gone)
`linked_accounts` (089), `intel_recommendation_engrams` (092),
`neural_router_models` (091 — but see drift note above).

---

## 2. Redis (12 logical DBs)

| DB | Owner | Contents |
|---|---|---|
| 0 | memory-service | `memory:ingestion:queue` (List, BRPOP) |
| 1 | llm-gateway (+ runtime config plane) | `nova:config:*` (inference.*, llm.*, memory.backend, features.*), rate-limit windows, response cache, budget tier |
| 2 | orchestrator | `nova:queue:tasks` (List), `nova:heartbeat:{task_id}` (30s TTL), agent state hashes, `nova:notifications` pubsub, `nova:flags:invalidate` pubsub |
| 3 | chat-api | WS session state |
| 4 | — | **unused** (was chat-bridge; service deleted 2026-07-01) |
| 5 | cortex | stimulus queue (BRPOP), cycle scratch |
| 6 | intel-worker | feed poll state, new-item queue |
| 7 | recovery | backup scheduler state |
| 8 | knowledge-worker | crawl state |
| 9 | voice-service | provider state |
| 11 | browser-worker | session registry |

---

## 3. OKF markdown memory bundle (filesystem, `$NOVA_WORKSPACE/memory/`)

Bind-mounted identically into memory-service, orchestrator (agent file tools),
and recovery (backup/reset) — the same files are visible to all three.

```
memory/
├── index.md                 # auto-maintained root index (always injected)
├── log.md                   # dated change log
├── journal/YYYY-MM-DD.md    # high-volume inbox (queue producers append digests)
│   └── archive/             # 45-day retention backstop moves old journals here
├── topics/<slug>.md         # concept files (curated knowledge)
├── people/<slug>.md
├── projects/<slug>.md
├── preferences/<slug>.md
├── sources/<slug>.md
└── .nova/
    ├── index.json           # BM25 index (self-heals on mtime drift)
    └── retrievals.jsonl     # retrieval log (query, surfaced ids, session)
```

**Frontmatter** = OKF v0.1 core fields + Nova extensions (written by
`store.py`/`backend.py`):

```yaml
type: note|topic|person|project|preference   # OKF core
title: …
description: …
tags: […]
timestamp: <ISO — last meaningful change>
resource: <optional source URI>
nova_source_kind: chat|tool|pipeline|cortex|journal|intel|knowledge|…
nova_trust: 0.70–0.95        # defaulted per source kind (TRUST_BY_SOURCE)
nova_session_id: …
nova_source_id: …
nova_tenant_id: …
```

Body links `[[like-this]]` are untyped graph edges (counted in `stats`).
Memory IDs are bundle-relative paths (e.g. `topics/nova-architecture.md`).

---

## 4. API contracts (`nova-contracts/nova_contracts/`)

The inter-service contract package — any service satisfying these models is a
drop-in replacement.

### memory.py — the memory-provider contract
- `ContextRequest{query, session_id, current_turn, depth: shallow|standard|deep, query_embedding?, max_results, tenant_id, mark_used}` → `ContextResponse{context, total_tokens, memory_ids[], retrieval_log_id?, metadata}`
- `MemoryIngestRequest{raw_text, source_type, source_id?, session_id?, occurred_at?, metadata{okf?}, tenant_id?}` → `MemoryIngestResponse{items_created, items_updated, item_ids[]}`
- `MarkUsedRequest{retrieval_log_id, used_ids[], session_id, tenant_id?}`
- `FeedbackRequest{memory_id, outcome_score ∈ [−1,1], session_id, tenant_id?}`
- `ProvenanceResponse{memory_id, source_kind?, …}`

### llm.py — the gateway contract
- `CompleteRequest{model, messages: Message[{role, content|ContentBlock[]}], tools: ToolDefinition[], temperature, max_tokens, tier, task_type, metadata}` → `CompleteResponse{content, tool_calls: ToolCall[], usage, …}`
- `StreamChunk` (SSE frames incl. thinking/progress), `EmbedRequest/Response`,
  `ModelInfo`, `ModelCapability`, `BlastRadius` (tool risk classes: READ/MUTATE/…),
  `ToolCallRef`.

### orchestrator.py / chat.py
- `AgentConfig/CreateAgentRequest/AgentInfo/AgentStatus`,
  `SubmitTaskRequest/TaskResult/TaskStatus/TaskType`,
- `ChatMessage/ChatMessageType/StreamChunkMessage/SessionInfo` (WS dialect).

### feature_flags*.py — flag SDK
`FlagDef`, `register_flag`, `flag_override` (contextvars-safe test scope),
`FlagResolver` Protocol + `DefaultResolver`, HTTP cache warm, pubsub
subscriber, `registry_clear` (test-only module — production must not import).

---

## 5. Auth model

| Mechanism | Use |
|---|---|
| `X-Admin-Secret` header | admin/service-to-service (value from `.env`, resolvable via nova-worker-common) |
| `Authorization: Bearer sk-nova-<key>` or `X-API-Key` | programmatic API keys (SHA-256 stored) |
| JWT (login / Google OAuth) + refresh tokens | dashboard users; RBAC roles |
| TrustedNetworkMiddleware (`TRUSTED_NETWORK_CIDRS`) | auth bypass for in-network calls — **history:** this bypass let `make test` trigger a factory reset (2026-07-01, fixed by requiring explicit admin credentials on destructive recovery endpoints) |
| Cortex API key | cortex→orchestrator task dispatch |

---

## 6. Config schemas

- **`.env`** (~100 keys, documented in `.env.example` 9.3 KB): infra knobs
  (`COMPOSE_PROFILES`, `POSTGRES_DATA_DIR`, binds), bootstrap secrets
  (mirrored to `platform_secrets` on first boot), `NOVA_WORKSPACE`,
  `REQUIRE_AUTH`, cortex budget/interval, voice keys.
- **Runtime config** (`platform_config` → Redis `nova:config:*`): the table in
  CLAUDE.md is accurate — inference.{backend,state,url,lmstudio_*},
  llm.{routing_strategy,embed_provider,default_chat_model,cloud_fallback_model},
  memory.provider_url, features.brain_enabled.
- **Feature flags** (separate system): naming taxonomy `kill.*`,
  `<system>.<behavior>`, `feature.*.enabled`, `ui.*`;
  CRITICAL_FLAGS denylist requires `confirm:` on PATCH
  (`pipeline.guardrail_strict_mode`, `pipeline.web_fetch_strict_sanitize`).
- **Context budgets** (orchestrator config): system 10% / tools 15% /
  memory 40% / history 20% / working 15%.
