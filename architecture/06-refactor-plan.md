# 06 — Refactor & Consolidation Plan

> **Audit date:** 2026-07-05. Owner guidance: pre-release, no users, breaking
> changes free; **consolidation explicitly on the table**. This plan favors
> fewer moving parts while protecting the three seams that are genuinely
> load-bearing.

---

## Guiding read of the architecture

Nova's shape is "one hub + many satellites". The hub (orchestrator) is
32k loc; six satellites are <2k loc each and exist mostly for process
isolation that a single-machine, single-user deployment doesn't need.
Meanwhile three seams **are** worth their cost:

1. **memory-service HTTP API** — the pluggable-provider product feature.
2. **llm-gateway** — provider secrets + restart-to-rotate + IDE surface.
3. **recovery** — must survive everything else dying (by design).

Cortex is a judgment call (see below). Everything else always-on is a
consolidation candidate.

---

## 1. Keep as-is (don't touch)

| Component | Why |
|---|---|
| Memory OKF backend + neutral API | small (2.3k loc), clean, no DB, the plug-point feature; keep `MemoryBackend` ABC + HTTP contract stable |
| LLM gateway | working, well-factored provider registry; the restart-on-rotation seam |
| Recovery + docker-socket-proxy | resilience by design; SEC-006b split is documented and sound |
| Pipeline state machine + checkpoint/reaper mechanics | robust, tested (crash-recovery tests) |
| Migration system (versioned SQL, no Alembic) | simple, works; do NOT introduce Alembic |
| Feature-flag system | complete: pubsub, fallback cache, audit, critical-flag gate |
| Capability platform (consent/credentials/audit) | ~15 test files; security-sensitive; leave alone |
| Dashboard | comprehensive; only add typegen (below), don't restructure |
| **Cortex as a separate service** | weakest "keep", but the brain's crash/restart independence from the serving path is worth one container while autonomy is under heavy iteration |

## 2. Consolidate (the actual restructuring)

### C1. chat-api → orchestrator — **recommended, low risk**
995 loc whose whole job is WS↔SSE adaptation against the orchestrator.
Move `/ws/chat` + session/drain logic into an orchestrator router; retire
redis db3 usage into db2 keys; keep the `nova-contracts/chat.py` WS dialect
unchanged so external clients don't notice; port 8080 can be preserved via
compose port mapping to orchestrator or dropped.
**Effort: M (1-2 days incl. tests).** Deletes: 1 container, 1 Dockerfile,
1 health surface. Tests to keep green: `test_chat_api.py`, `test_chat_pod.py`.

### C2. intel-worker → orchestrator background task — **recommended, lowest risk**
576 loc of pollers with zero local state (its state already lives in
orchestrator tables + redis). The orchestrator already runs 8 background
loops (incl. the GitHub poller — a sibling pattern). Feed CRUD/API already
lives in `intel_router.py`.
**Effort: S-M (1 day).** Deletes: 1 container. Redis db6 folds into db2.

### C3. voice-service → llm-gateway — **recommended**
592 loc OpenAI STT/TTS proxy; the gateway already owns provider keys and
HTTP-to-provider plumbing. Mount as `/v1/audio/*`-style routes; retarget the
dashboard `/voice-api` nginx proxy to the gateway.
**Effort: S-M (1 day).** Deletes: 1 container + the dead Deepgram/ElevenLabs
compose vars (05·D5) in the same stroke.

### C4. knowledge-worker — **keep optional, standalone** (screenpipe-bridge removed 2026-07-06)
With screenpipe-bridge deleted outright (licensing/abstraction mismatch — see
`docs/superpowers/specs/2026-07-06-generalized-ingestion-endpoint.md`), the
original "merge two external-IO producers into one ingest-worker" rationale
dissolves. knowledge-worker is the only remaining optional external-IO
producer; keep it as its own profile-gated service. External-source ingestion
now routes through the generalized HTTP ingestion endpoint (new, additive)
rather than per-source bridge services.
**Effort: 0 (decision, not work).** Frees redis db10.

### C5. browser-worker — **keep separate.** The Playwright image (~1.5 GB) is
the reason it exists as a profile; merging would bloat the orchestrator image
for everyone.

### End state (always-on): postgres, redis, socket-proxy, orchestrator,
llm-gateway, memory-service, cortex, recovery, dashboard — **9 containers
(from 12)**, and the mental model "hub + brain + memory + gateway + lifeboat".

### Consolidation ground rules
- One move per PR; `make test` green before the next.
- Each move updates: compose, Makefile, CLAUDE.md service table, website
  architecture doc, dashboard proxy config (if touched), redis DB map (03).
- Redis DB remap happens opportunistically (a fresh `docker compose down &&
  up` world — no live-data migration needed pre-release).

---

## 3. Fix (broken or wrong, from 05)

| # | Item | Effort |
|---|---|---|
| F1 | `chmod +x scripts/*.sh` (unbreaks `make backup`) + CI executable-bit check | XS |
| F2 | Migration `093_drop_legacy_memory_tables.sql` (9 orphan tables) + remove `embedding_cache` from factory reset + optional engram→memory column rename | S |
| F3 | Stale compose comments (bundled inference), dead voice env vars, CORS `3001→3000`, `.env` `COMPOSE_PROFILES` dead values | S |
| F4 | TODOS.md + CLAUDE.md truth pass (maturation shipped; no SQLAlchemy; ~90 tests; provider file names) | S |
| F5 | Test-dep single source: make target reads `tests/requirements.txt` | XS |
| F6 | docs/ archive pass: `docs/archive/` for engram-network, chat-bridge plans, completed 2026-03 plans; one living roadmap | M |
| F7 | **Factory reset re-seeds** — reset clears `schema_migrations` so idempotent migrations (and their seeds: intel feeds, system goals, `no-rm-rf` rule, master-key/trusted-network config rows) re-run on next boot (05 §5·A, ~11 test failures) | S |
| F8 | **Gateway skips credential-invalid providers** in the fallback chain + maps provider-auth errors to a clear 4xx instead of raw 500; rotate/remove the dead Groq key on this host (05 §5·B, ~15 failures) | S-M |
| F9 | **Test-suite repair**: pytest-timeout in `pytest.ini` (signal method); delete/rewrite ~12 stale tests (BYO-era inference endpoints, sandbox-rename routes, `app.drives` imports); issue explicit auth-posture verdicts for the ~8 endpoints answering 200 unauthenticated (05 §5·C/D) | M |

## 4. Security hardening (from 05 §3, ordered)

| # | Item | Effort |
|---|---|---|
| SEC1 | Default `$HOME` mount to `:ro` (flip `NOVA_HOME_MOUNT` default; home-tier enable flow explains how to opt into rw) | S |
| SEC2 | Trusted-network bypass → explicit endpoint allowlist (invert the model that caused the factory-reset incident) | M |
| SEC3 | Verify FC-002 hard-fails on default admin secret when `REQUIRE_AUTH=true` (test exists? add one) | S |
| SEC4 | FU-010: migrate infra-only keys to `platform_config`, drop `.env` mount to `:ro` | M |
| SEC5 | FU-009: platform-secret hot-reload in gateway (removes restart-to-rotate) | M-L |

## 5. Build (capability gaps, from 04)

| # | Item | Notes | Effort |
|---|---|---|---|
| B1 | **Human checkpoint primitive** — `request_human_checkpoint(reason, instructions, screenshot?)` tool; `approval_requests.response_text`; task parks in `waiting_human`; `approval_worker` re-enqueues with the reply injected; dashboard reply box | unblocks unattended browser signups AND gives cortex review a reply channel — one primitive, two features | M (3-4d, design already in TODOS.md) |
| B2 | **Learning from failures** — PLAN phase queries `/api/v1/memory/context` for reflection entries related to the goal; include in planning prompt | pure retrieval change now that reflections flow into OKF | S-M (2-3d) |
| B3 | **Decouple journal curation from the brain toggle** — memory-service-side scheduled consolidation (it already has `consolidate()`; extend to LLM-distillation via gateway, or a standing orchestrator cron) so memory works brain-off | protects pillar 1 on default installs | M |
| B4 | **Pydantic→TS typegen** for the dashboard (e.g. generate from nova-contracts + router response models into `dashboard/src/types/generated.ts`) | kills the silent-drift class; do before writing dashboard tests | M |
| B5 | Retrieval quality flywheel: make the existing RetrievalTuningLoop + `benchmarks/` harness produce a tracked metric (precision@5 on a fixed case set) so BM25 changes are measurable | decides whether `benchmarks/` lives (05·D11) | M |

## 6. Refactor (maintainability, do opportunistically)

| # | Item | Effort |
|---|---|---|
| R1 | Split `router.py` (1,668) by resource: chat, agents, keys/usage, openai_compat | M |
| R2 | Extract from `executor.py` (2,014): notifications, summary builder, cost accounting | M |
| R3 | Extract from `runner.py` (1,343): prompt builder, tool loop | M |
| R4 | Decide write-only tables (`audit_log`, `conversation_outcomes`, `pipeline_training_logs`): build readers or stop writing | S each |

## 7. Do NOT do (explicit non-goals)

- **No Alembic / no ORM** — current migration+asyncpg pattern is a feature.
- **No embeddings/vector memory rewrite** — BM25 + curation is the bet; add an
  alternative *backend* behind the existing API if ever needed (that's what
  the seam is for). pgvector image stays (free option value).
- **No merging cortex into orchestrator** (this round) — revisit after
  autonomy iteration slows.
- **No Prometheus/Grafana** — logs + health + friction log suffice pre-release.
- **No multi-tenant buildout** — keep scaffolding dormant; it's not the product.
- **No microservice-ing the orchestrator** — the monolith hub is fine; split
  files, not services.

---

## 8. Recommended order of operations

```
Phase 0  "Truth pass"            (half a day)   F1 F3 F4 F5 + pytest-timeout config (F9a) + delete workspace/ (05·D1) + PROMPT.md (05·D10)
Phase 1  "Make the suite honest" (1-2 days)     F7 (reseed-on-reset) → F8 (gateway provider-skip + key rotation) → F9 (stale-test rewrite + auth verdicts) → F2 (migration 093)
Phase 2  "Safe defaults"         (2-3 days)     SEC1 SEC2 SEC3
Phase 3  "Consolidation"         (1-1.5 weeks)  C2 → C1 → C3 → C4  (one PR each, suite green between)
Phase 4  "Autonomy + memory"     (1-1.5 weeks)  B1 → B2 → B3
Phase 5  "Quality & polish"      (ongoing)      B4 B5, R1-R4, F6 docs archive, SEC4 SEC5, website docs for consolidated services
```

Phase 1 first: consolidation (Phase 3) is only safe with a suite whose
failures mean something. After F7+F8+F9 the suite should be green-or-explained
end to end — from there, every later phase has a regression net.

Rationale for the order: Phases 0-1 are hours of work that make every later
diff cleaner and the docs trustworthy. Phase 2 closes the one genuinely
scary default (home rw) before consolidation churns compose. Phase 3 shrinks
the surface everything later touches (fewer services to document, secure,
and test). Phase 4 is the product work — it lands on a smaller, safer base.

## 9. Complexity summary

| Task | Size | Prereqs |
|---|---|---|
| Phase 0 bundle | XS-S | none |
| Migration 093 | S | none |
| Home mount ro default | S | none |
| Trusted-network allowlist | M | none |
| intel→orchestrator | S-M | Phase 0 |
| chat-api→orchestrator | M | none |
| voice→gateway | S-M | none |
| knowledge-worker: keep standalone (screenpipe removed) | — | none |
| Human checkpoint | M | none (design in TODOS.md) |
| Learning from failures | S-M | none |
| Curation decoupling | M | none |
| Typegen | M | none |
| Monolith splits R1-R3 | M each | best after Phase 3 |
| FU-009/FU-010 | M-L | after consolidation |
