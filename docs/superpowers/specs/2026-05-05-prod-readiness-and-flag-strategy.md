# Production-Readiness Audit & Feature-Flag Strategy

**Date:** 2026-05-05
**Status:** Draft — awaiting approval before plan + execution
**Worktree:** `engineer-prod-readiness-audit` (this memo); referenced work in `flags-001-foundation`
**Author scope:** Audit + build-vs-buy decision memo. No code changes in this memo's worktree.

---

## TL;DR

**Continue the in-flight DIY feature-flag system in `flags-001-foundation`, but block the v1 ship on five critical changes that emerged from the role-advisor pass.** Flagsmith is the named migration target if/when SaaS audit/SOC2 pressure makes DIY untenable. The build-vs-buy delta is real but small relative to the cost of fixing two latent design errors in the existing spec — those errors travel with you to Flagsmith and must be resolved either way. Production-readiness audit found 15 Nova features that need flag treatment today, two of which (self-modification and home-sandbox tier) deserve **stronger** gating than v1's admin-secret-only auth model provides.

The five blockers (detail in §6):

1. **Cache-warm semantics**: `.value()` must be synchronous and pre-warmed at service startup, not "fetch on cache miss" as the existing spec suggests.
2. **Kill-switch failure mode**: services must fall back to **last-seen cached value**, not in-code default, when orchestrator/Redis unreachable. The current design fails *open* on partition — wrong direction for kill switches.
3. **Audit fidelity**: `set_by="admin"` literal makes the audit trail useless once two humans share the secret. Capture `actor_ip`, `actor_user_agent`, `request_id` in v1, not Phase 2.
4. **Critical-flag confirmation**: hardcoded denylist of catastrophic flags (`kill.engram.ingestion`, `kill.consolidation.cycle`, `kill.cortex.thinking_loop`, `pipeline.guardrail_strict_mode`, `pipeline.web_fetch_strict_sanitize`) must require a second-confirm token on PATCH, not Phase 2.
5. **Sandbox/selfmod exclusion**: `selfmod.*` and `sandbox.*` must NOT migrate to flag-gated under v1's admin-secret-only model — they require RBAC + per-write confirmation, deferred to Phase 2.

Cost of the five fixes is ~1.5 days on top of the existing 6-7-day v1 estimate (so ~8-9 total). Cost of swapping to Flagsmith is ~2 weeks of integration + new ops surface area + Postgres migration-runner coordination hazard. DIY wins.

---

## 1. Production-Readiness Audit

Source: deep-read of all 9 services + roadmap + audits directory in worktree `engineer-prod-readiness-audit`.

**Headline:** 15 features ship in code that aren't uniformly production-ready for a brand-new install. Roughly one-third "shipping but risky without a kill switch," one-third "partially built, missing pieces affect user-visible behavior," one-third "correctly profile-gated but has documented gaps before general availability."

| # | Feature | Service / Path | Current gating | Maturity | Recommended flag treatment |
|---|---|---|---|---|---|
| 1 | Self-modification (GitHub PR by agents) | `orchestrator/app/tools/github_tools.py:172`, `config.py:124`, `.env.example:181` | env-var (`SELFMOD_ENABLED=false`) | feature-complete-but-risky | **Keep env-var; do NOT migrate to flag system in v1** (security advisor blocker) |
| 2 | Cortex autonomous brain loop | `cortex/app/config.py:36`, `docker-compose.yml:576`, `dashboard/.../BrainSection.tsx:13` | env-var (`CORTEX_ENABLED`) + redis-config (`features.brain_enabled`) | partial | Kill switch flag; default-off for resource-limited installs |
| 3 | Neural Router ML re-ranker | `memory-service/app/config.py:79-92`, `engram/neural_router/train.py`, `docker-compose.yml:300-322` | hardcoded (activates after 200+ obs; trainer container always-on) | experimental | Flag the trainer-container start + the router switch-in |
| 4 | Screenpipe bridge | `screenpipe-bridge/app/main.py`, `docker-compose.yml:763-808`, redis (`screenpipe.enabled`) | redis-config + **no compose profile** (service starts unconditionally) | experimental | **Most acute issue:** add compose profile or gate at startup; today it runs for every install |
| 5 | Memory tools retrieval mode | `orchestrator/app/config.py:30`, `agents/runner.py:101` | env-var (`memory_retrieval_mode`) | partial | Phase-2 candidate per existing spec; high-priority migrate |
| 6 | Cortex goal maturation | `cortex/app/maturation/triage.py`, `drives/maintain.py:34` | unguarded (triage fires; executor missing) | partial | Flag triage dispatch separately from missing executor |
| 7 | LLM intelligent routing | `llm-gateway/app/`, redis (`llm.intelligent_routing=false`) | redis-config | partial | Existing toggle correct; formalize as named flag |
| 8 | Home-sandbox tier (`$HOME` mount) | `orchestrator/app/tools/sandbox.py:27-40`, `docker-compose.yml:386` | unguarded (mount always present; tier set per-task w/o admin gate) | feature-complete-but-risky | **Keep env-var; do NOT migrate to flag system in v1** (security advisor blocker) |
| 9 | Knowledge worker (autonomous crawl) | `knowledge-worker/app/scheduler.py`, `docker-compose.yml:657-708` | compose-profile (`knowledge`) + scheduler.py:111 TODO | partial | Profile gating correct; complete credential wire-up before recommending |
| 10 | Voice chat | `voice-service/`, `docker-compose.yml:710-760` | compose-profile (`voice`) | partial | Profile correct; cost tracking + rate limiting missing |
| 11 | Multi-tenant RBAC data isolation | `orchestrator/app/goals_router.py`, `pipeline_router.py`, roadmap §370-396 | unguarded (tenant_id not enforced) | partial | Flag multi-tenant mode separately from single-tenant auth |
| 12 | Chat bridge (Telegram/Slack) | `chat-bridge/`, `docker-compose.yml:452-504` | compose-profile (`bridges`) | partial | Profile correct; Telegram broken per roadmap.md:252 |
| 13 | Cortex learning from experience | `cortex/app/reflections.py`, `drives/learn.py` | unguarded (no integration test for benchmark scoring) | experimental | Flag capability-gap signal + quality drive actions |
| 14 | Embedded editors (VS Code / Neovim) | `docker-compose.yml:837-887`, `.env.example:146-156` | compose-profile (`editor-vscode`, `editor-neovim`) | experimental | Profile correct; VS Code `--auth=none` is a separate security finding |
| 15 | Quality loop / AI benchmarking | `orchestrator/app/quality_router.py`, `cortex/app/drives/quality.py` | unguarded (drive polls unconditionally; benchmark cases not seeded) | experimental | Gate until cases loaded |

**Total:** 15 features warrant flag treatment. **2** (#1, #8) explicitly should **NOT** be migrated to v1's flag system because they grant agents host-filesystem write or PR-creation rights and v1's auth is admin-secret-only.

**Watch list** (close to ready, small-fix-then-remove-from-flag-list):

- **Self-modification** — `_preflight()` guard + rate limiter are solid; missing is a per-user UI confirmation stored in `platform_config`. Adding that makes it flag-grade rather than env-var-grade.
- **Voice chat** — needs one integration test covering STT→response→TTS round trip, then it's clean.
- **LLM intelligent routing** — already effectively a flag in Redis; just needs Settings UI surface.
- **Neural router** — 200-observation organic activation is fine; the always-on trainer container is the cost — gate at entrypoint with `neural_router_enabled`.

---

## 2. State of `flags-001-foundation` (in-flight DIY work)

**Spec:** `docs/superpowers/specs/2026-05-05-feature-flags-design.md` (470 lines, today's date) — high-quality, Nova-native (asyncpg + Redis pubsub + Postgres + Pydantic). Resolution order is sensible: test override → env-var → in-process cache → DB → in-code default. Multi-tenant API-forward-compatible (`.value(tenant_id, user_id)` accepts but ignores). 8-day total estimate.

**Plan:** `docs/superpowers/plans/2026-05-05-feature-flags-v1.md` — TDD-shaped (each task is failing-test → verify-fail → implement → verify-pass → commit). Mirrors the SEC-006a `platform_secrets` pattern.

**What's built (4 commits ahead of main):**

| Commit | Reality |
|---|---|
| `28288e47 — migration 083` | **Production-ready.** Both tables, JSONB `value`, audit CHECK constraint on action, index on (key, occurred_at DESC). |
| `1b31ce38 — FlagDef stub` | `FlagDef.value()` returns `self.default` unconditionally. **No cache, no env-var probe, no HTTP fetch, no `flag_override`, no resolver.** |
| `ace12bba — register_flag` | Validation logic for bool/enum + idempotent re-registration is correct. Frozen dataclass. `_registry_clear` test helper exposed at module level (cicd risk — see §6). |
| (test commits) | Migration test asserts column sets. Resolver tests exercise only validation + the `self.default` return path. **Six tests, all green; zero coverage of cache, pubsub, env-var, HTTP fallback, or `flag_override` (which doesn't exist).** |

**Spec divergence detected:** SDK landed in `nova-worker-common/nova_worker_common/feature_flags.py`, but the spec specifies `nova-contracts/feature_flags.py`. `nova-worker-common` is heavier (already has `http_client.py`, `rate_limiter.py`, `credentials/`). Any service that only needs flag eval pulls in extra weight. **Decision needed:** ratify the divergence (move spec) or fix the location (move code). Backend advisor leans "fix code location."

**Remaining v1 work:** ~6-7 focused engineering days (orchestrator store + router, SDK cache + resolver + env-var + `flag_override`, 6× per-service wiring, Settings UI section, 8 first-flag wirings, integration tests, docs).

**Migration number gap:** `081_tasks_user_id.sql` → `083_feature_flags.sql`. `082` is claimed by **sec-006b-socket-proxy** (sibling worktree) — confirmed via `082_platform_secrets.sql` belonging to sec-006a. Gap is survivable only because Nova's runner glob-sorts and runs idempotently, but coordination is fragile under parallel-branch development. CICD advisor mandates a pre-merge migration-gap check.

---

## 3. Build vs Buy Analysis

### Comparison table

| Candidate | License | Self-host footprint | Python SDK | Admin UI | Multi-env | Multi-tenant | Audit log | OpenFeature | Targeting | Notable limits | Last release |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Unleash** | Apache 2.0 — OK | 1 Node app + Postgres share, ~250-400 MB RAM | sync-only, polling-based local eval | yes | **OSS=2 envs max** — paid for more | no native | OSS basic event log | yes | full | RBAC/SSO/Projects = paid tier | v7.6.3 (2026-04-15) |
| **Flagsmith** | BSD-3 — OK | Django API + React frontend + Postgres share, ~500 MB | sync, supports local-eval (60s poll) or remote | yes | **yes (unlimited self-host)** | yes ("organisations") | yes | yes | full | Enterprise: SAML/LDAP/SSO/Oracle/MySQL | v2.231.1 (2026-04-29) |
| **GrowthBook** | MIT + Enterprise License — OK with caveat | monolith + **MongoDB** | **first-class async** | yes | Enterprise-only | Enterprise-only | Enterprise-only | yes | full + A/B stats | **MongoDB is the dealbreaker for a Postgres shop** | v4.3.0 (2026-02-04) |
| **OpenFeature + flagd** | Apache 2.0 — OK | 20 MB Go binary, no DB, JSON config | community provider, sync | **none** | by running multiple flagds | none | **none** (git history of JSON) | reference impl | full via JsonLogic | no UI/audit/RBAC — you build all of it | core/v0.15.5 (2026-04-30) |
| **PostHog FF** | MIT (EE exception) — N/A | 9 services (Postgres + ClickHouse + Kafka + Zookeeper + Redis + ...), heavyweight footprint | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **Blocked — not separable from full PostHog; outsized footprint for a flag system** | n/a |
| **DIY (flags-001)** | Nova's own (commercial-OK) | 0 new processes; existing Postgres + Redis | native (no SDK install) | none yet — Settings page section planned | none in v1 | designed in for Phase 3+ | already specified | future-optional | achievable | maintenance burden; community plugins absent | living code in `flags-001-foundation` |

### Verdicts

- **Unleash**: Solid Apache 2.0 license, mature, Postgres-friendly. **Wall**: 2-env OSS cap + RBAC behind paid tier. Year-out SaaS will hit it. Today's ~5-10 flags doesn't push limits, but you outgrow at exactly the moment SaaS pressure starts. Skip.
- **Flagsmith**: Best license posture. OSS self-host actually unlimited (tier limits are on Cloud, not self-host). Postgres-native. Sync Python SDK requires `run_in_executor` wrapping in Nova's async stack — friction, not blocker. **Real cost**: 2 new containers, Django migration runner conflict with Nova's SQL migration runner, recovery service doesn't back up Flagsmith's data. Reasonable migration target year-out, but not now.
- **GrowthBook**: Best Python SDK by margin (async-first, FastAPI-shaped). **Dealbreaker**: requires MongoDB. Adding a new database engine for a flag system is the wrong tradeoff. Skip.
- **flagd**: Architecturally elegant for *today* (20 MB, no DB, JSON config, ~50 MB RAM). **Wall**: no UI, no audit, no persistence layer. For 5-10 flags managed by one person via git-versioned JSON, this is genuinely fine. For multi-tenant SaaS with audit/SOC2 pressure, you build the management plane yourself = reinvent Unleash badly. Strong tactical choice, weak strategic one.
- **PostHog FF**: Blocked — full PostHog stack carries far too many services for a flag-only need; not separable. Don't consider.
- **DIY (flags-001)**: Already started. Zero new infra. Async-native. Fits Nova patterns. Honest weakness: SOC2/audit hardening is real work (1-2 weeks to peer with Flagsmith on those axes). Win is full control, no async/sync impedance, no new DB engine, OpenFeature provider remains future-optional.

### Decision matrix

**Today (single-tenant self-hosted, 5-10 flags):**

1. **DIY** — already 1/8 done, zero infra cost, async-native, fits Nova patterns
2. flagd — only if you want OSS optionality without writing flag-eval code
3. Flagsmith — only if you want a real admin UI *now* and accept 2 new containers
4. Unleash — works fine but 2-env cap will bite at SaaS time
5. GrowthBook — skip (Mongo)
6. PostHog — blocked

**Year-out (multi-tenant SaaS, dozens of flags, audit/SOC2 pressure):**

1. **Flagsmith** — best license + best self-host story (audit + multi-env + multi-org all in OSS), Postgres-native, and OpenFeature provider means application code doesn't change if Nova adopts the OpenFeature interface today
2. DIY hardened — viable if Nova commits to the audit/admin-UI work
3. Unleash Pro — most polished if you pay; cost compounds with seats
4. flagd + custom UI — don't (you'd be writing Flagsmith)
5. GrowthBook Enterprise — skip (Mongo + license complexity)
6. PostHog — blocked

---

## 4. Decision: Continue DIY, design for swap-out

**Recommendation:** continue `flags-001-foundation`, ship it as the Phase 1 DIY system, AND add two design changes the existing spec doesn't yet require:

1. **OpenFeature-shaped interface** at the SDK boundary. The internal `FlagDef.value()` API stays Nova-native, but a thin OpenFeature provider adapter sits behind it so a future swap to Flagsmith only changes the resolver wiring. Concrete shape: a `FlagResolver` Protocol class with `resolve_bool(key, default, context)` / `resolve_string(...)` methods; the in-process cache + DB fetcher implements it today, a Flagsmith adapter implements it tomorrow.
2. **`feature_flag_audit` table from day one** (the existing spec already specifies this — confirming it as a v1 acceptance criterion, not a follow-up).

**Why DIY wins now:**

| Axis | DIY | Flagsmith |
|---|---|---|
| Footprint cost | ~5-10 MB resident in existing services | ~400-500 MB across 2 new containers |
| New containers | 0 | 2 (Django API + React frontend) |
| New DB engines | 0 | Schema entanglement OR sidecar Postgres |
| Migration-runner coordination | trivial (Nova owns it) | Django + Nova both apply migrations on startup → race risk |
| Backup coverage | inherited (recovery service) | requires separate cron/process |
| Async impedance | none (Nova-native) | sync SDK → `run_in_executor` per eval |
| Flag-promotion across envs | not yet (Phase 3+) | first-class |
| Audit/SOC2 readiness | 1-2 weeks of hardening | out-of-box |
| Time-to-v1 | ~7-9 days (~6-7 + 1.5 of mandatory fixes) | ~2 weeks integration + new ops surface |

The Flagsmith advantages (multi-env + audit + multi-tenant in OSS) are real but **none of them are decision-driving for today's 5-10-flag, single-tenant, self-hosted scope.** Year-out, when SaaS launches and SOC2 pressure starts, Flagsmith's stronger out-of-box posture starts to dominate — at which point the OpenFeature interface provides the swap path.

**What we're explicitly NOT recommending:**

- Don't build a "lite Flagsmith" — feature creep on the DIY system means rewriting Flagsmith badly. Phase 3+ percentage rollouts and predicate rules are the line where Flagsmith becomes the right move.
- Don't migrate `selfmod.*` or `sandbox.*` to the flag system in v1 (security advisor blocker — admin-secret-only auth model is too weak for those).
- Don't ship v1 without the five blockers in §6 fixed.

---

## 5. Role-Specific Acceptance Criteria

These become reviewer gates for the v1 PR. Roles cited; each criterion has the role-advisor that surfaced it.

### Backend (must-have)

- **B1.** `FlagDef.value()` MUST be synchronous and non-blocking on the hot path. The in-process cache MUST be **bulk pre-warmed at service startup** (single async HTTP call per service lifespan, fills entire cache). Inline HTTP calls from within `.value()` are forbidden. *Reason: lazy fill on async-but-`.value()`-is-sync is a footgun the spec's wording invites.*
- **B2.** SDK MUST degrade gracefully when orchestrator is unreachable at startup: log `WARNING`, leave cache empty, return in-code defaults. **Never** raise; never block service startup.
- **B3.** `flag_override()` context manager MUST be process-local using `contextvars.ContextVar` (not `threading.local`) and MUST work with zero running services — pure import + context manager.
- **B4.** Pubsub subscriber MUST be a named `asyncio.Task` registered in FastAPI lifespan and cancelled/awaited on shutdown. Every `get_redis()` MUST have matching `close_redis()` per Nova convention.
- **B5.** Registry-announce call MUST retry-with-backoff (≥3 attempts, 2s initial delay) and log `WARNING` (not `ERROR`) on total failure. A failed announce is non-fatal.
- **B6.** Flag admin PATCH MUST execute UPSERT + audit INSERT in a single asyncpg transaction acquired from the **shared orchestrator pool**. Pubsub PUBLISH happens after commit; failed PUBLISH logs `WARNING` and does not roll back.

### Security (must-have, v1 — not Phase 2)

- **S1.** `feature_flag_audit` MUST capture `actor_ip`, `actor_user_agent`, `request_id` columns in v1. *Reason: shared admin secret makes `set_by="admin"` literal useless for incident response.*
- **S2.** Env-var override path (`NOVA_FLAG_<KEY>`) MUST emit a structured `WARN` log on every read it resolves: `flag_envvar_override_used` with key, resolved value, service, PID. *Reason: closes the audit-bypass path.*
- **S3.** Hardcoded `CRITICAL_FLAGS` set MUST require a `confirm: <flag-key>` body field on PATCH. Initial set: `{kill.engram.ingestion, kill.consolidation.cycle, kill.cortex.thinking_loop, pipeline.guardrail_strict_mode, pipeline.web_fetch_strict_sanitize}`. UI surfaces second-modal confirm.
- **S4.** `selfmod.*` and `sandbox.*` flags MUST NOT be flag-gated in v1 — they retain `.env` boot-time gating. Block migration until Phase 2 RBAC + per-write confirmation token lands.
- **S5.** PATCH/DELETE on `/api/v1/feature-flags/*` MUST be rate-limited (5/min/IP). Failed-auth attempts MUST audit-log as `action='auth_fail'` with IP.
- **S6.** Phase 3+ multi-tenant isolation MUST be specified in the spec before any tenant-scoped row lands: (a) cross-tenant reads return 404, (b) registry endpoint is global, (c) flag values with PII get an `is_sensitive` column with masked reads. *(Doc-only acceptance criterion; not a code change in v1.)*

### SRE (must-have)

- **SR1.** Every service that applies an invalidated flag value MUST emit a structured `INFO` log line within the cache TTL window: flag key, old value, new value, propagation source (pubsub vs TTL). Both paths log; silence on TTL is the current gap.
- **SR2.** Env-var break-glass MUST be documented as a **boot-time default mechanism only**, NOT a hot kill-switch. *Reason: changing `NOVA_FLAG_<KEY>` requires container restart, which defeats the entire kill-switch use case.* Spec language must be corrected to remove the misleading "operator break-glass" framing for hot paths.
- **SR3.** Kill-switch flags MUST fall back to **last-seen cached value**, not in-code default, when orchestrator/Redis unreachable. *Reason: in-code default for `kill.*` is `false` (feature-enabled) — services would silently disarm kill switches during a network partition. Wrong failure mode.* Implementation: cache stores the last-fetched value durably (write-through to a small per-service file under `data/flag-cache/`) and re-reads on cold start before attempting fresh fetch.
- **SR4.** `GET /health/ready` on each flag-consuming service MUST include `flag_pubsub_connected: bool`. Settings UI MUST surface a warning when any service reports disconnected.
- **SR5.** A kill-switch runbook MUST exist before any `kill.*` flag ships, documenting: expected effect, propagation latency bounds (1-60s), verification steps (which log line confirms the switch took effect), rollback procedure.

### Cloud (must-have)

- **C1.** Flag system MUST add zero new containers and zero new processes for a default `docker compose up`.
- **C2.** Flag tables MUST live in the primary Nova Postgres database — covered by existing `make backup` / `make restore` and recovery service backup logic with no additional configuration.
- **C3.** Flag admin router MUST share the existing orchestrator asyncpg connection pool — no second pool opened.
- **C4.** Flag system MUST NOT require changes to nginx config or dashboard reverse-proxy. The flag UI lives in the existing dashboard; the API lives on the existing orchestrator.
- **C5.** OpenFeature-compatible interface boundary MUST be a real Protocol class (not a naming convention), so swap-to-Flagsmith requires only a new resolver adapter, not a flag-consumer rewrite.

### CICD (must-have)

- **CI1.** `flag_override` MUST be implemented in `nova_worker_common/feature_flags.py` (or `nova-contracts/feature_flags.py` if location is corrected) and exported before any test imports it. Currently `test_feature_flags_resolver.py` imports a symbol that does not exist — CI will fail at collection time.
- **CI2.** `tests/conftest.py` MUST include a `flags_clean` autouse fixture that truncates `feature_flags` and `feature_flag_audit` **after** each test (so failure state is inspectable).
- **CI3.** Pubsub propagation assertion MUST poll with timeout ≥5s (`PUBSUB_PROPAGATION_TIMEOUT_S = 5` constant), not `asyncio.sleep(2)`.
- **CI4.** `_registry_clear` MUST move to `nova_worker_common.feature_flags_testing` (or `nova_contracts.feature_flags_testing`) submodule so production services cannot accidentally import it.
- **CI5.** Pre-merge migration-gap check MUST run in CI: `ls migrations/*.sql | awk -F'[/_]' '{print $1+0}' | sort -n | awk 'prev && $1!=prev+1{print "GAP after "prev; exit 1} {prev=$1}'`. Coordination with `sec-006a-platform-secrets` (which owns 082) MUST happen before flags-001 merges.
- **CI6.** Phase-3 multi-environment schema migration is a primary-key restructure (`PRIMARY KEY(key)` → `PRIMARY KEY(key, environment)`), not a column add. Spec MUST capture this fact in §"Phase 3+: Tenant Targeting" so it isn't a deadline-pressure surprise later.

---

## 6. Risks & Open Questions

Carrying forward and updating the existing spec's risks. **Bold** items are new from this memo's analysis.

1. **Pubsub failure tolerance** — services miss invalidations during Redis disconnects; 60s cache TTL bounds staleness. Per SR3, last-seen cache is the new fallback (not in-code default). Per SR4, pubsub-disconnect is a health-signal field.
2. **Cross-service registry aggregation** — POST-on-startup pattern; eventual consistency. Per B5, retry-with-backoff is mandatory.
3. **Variant typos at write time** — registry validation on PATCH + runtime validation on `.value()`. Defense in depth; existing spec is fine.
4. **Audit log retention** — append-only, unbounded growth. Out of v1 scope; tracked as REL-014-style cleanup follow-up.
5. **Test override hygiene** — per B3, `contextvars.ContextVar` (not `threading.local`); per CI1 the implementation must exist before merge.
6. **Overlap with `platform_secrets`** — both want pubsub invalidation. Spec keeps separate; revisit Phase 2.
7. **Naming conventions** — lowercase dotted `<area>.<thing>`, `kill.*` prefix. Convention only in v1. Spec already documents.
8. **[NEW] Migration number coordination** — flags-001 owns 083, sec-006a owns 082, sec-006b owns 084 (TBD). Per CI5, pre-merge gap check enforced.
9. **[NEW] SDK location ratification** — spec says `nova-contracts/`, code lives in `nova-worker-common/`. **Open**: which is right? Backend advisor recommends `nova-contracts` (matches spec rationale). **Deferred to plan phase.**
10. **[NEW] OpenFeature interface shape** — Protocol class with `resolve_<type>(key, default, context)` methods. Exact context-object shape (Nova-internal vs OpenFeature standard `EvaluationContext`) is a plan-phase decision.
11. **[NEW] Recovery service flag eval** — Recovery (8888) doesn't depend on Redis. If `kill.recovery.*` flags ever ship, Recovery must poll Postgres directly. **Out of v1 scope — capture as Phase 2 candidate.**

---

## 7. Out of Scope (this memo)

- The follow-on plan itself (depends on user approving this memo).
- Writing any code in this worktree (the implementation worktree is `flags-001-foundation`).
- Resolving open question #9 (SDK location) — that's a plan-phase decision.
- Resolving open question #10 (OpenFeature shape) — that's a plan-phase decision.
- Phase 2 migrations (existing `.env` and `nova:config:*` toggles into flags) — those land after v1 is stable.
- Per-tenant / per-user targeting (Phase 3+).
- Percentage rollouts, multi-arm experiments, predicate rules.
- A separate "experiments" subsystem (different shape; revisit when Nova has user analytics).

---

## 8. Follow-On Plan Outline

If this memo is approved, the next session produces `docs/superpowers/plans/2026-05-05-prod-readiness-and-flag-strategy.md` with three logical phases:

**Phase A — Resolve flags-001 design errors and quality gates (1.5 days net new on top of existing 6-7-day estimate):**

- Move SDK to `nova-contracts/feature_flags.py` (or document rationale for keeping in `nova-worker-common`).
- Implement `flag_override` (CI1) before anything else — unblocks existing tests at collection time.
- Move `_registry_clear` to `feature_flags_testing` submodule (CI4).
- Update `feature_flags_audit` schema with `actor_ip`, `actor_user_agent`, `request_id` (S1).
- Update spec language to remove misleading "env-var as hot kill-switch" framing (SR2).
- Specify Phase 3+ multi-tenant isolation invariants in spec (S6).
- Document Phase 3+ multi-env schema as a primary-key restructure (CI6).

**Phase B — Complete v1 with role-blocker fixes baked in (~6-7 days, the existing spec's remaining work):**

- Bulk pre-warm cache (B1), graceful startup degradation (B2), pubsub task lifecycle (B4), retry-with-backoff registry announce (B5), shared pool transaction (B6), OpenFeature Protocol (C5).
- Last-seen-value durable cache (SR3) — small per-service file under `data/flag-cache/`.
- Structured INFO log on every flag application (SR1) and pubsub-disconnect health field (SR4).
- `CRITICAL_FLAGS` confirm mechanism (S3) + rate limit + auth-fail audit row (S5) + env-var override audit log (S2).
- Migration-gap CI check (CI5) + 5s pubsub propagation timeout (CI3) + flags_clean fixture (CI2).
- Settings UI section + 8 first-shipping flags wired into call sites.
- Kill-switch runbook (SR5).

**Phase C — Audit-cleanup tasks (parallel; not blocked on flag system):**

- Add compose profile for `screenpipe-bridge` (audit row #4 — most acute issue).
- Document `selfmod.*` and `sandbox.*` exclusion from v1 flags in CLAUDE.md and `.env.example`.
- Add `data/flag-cache/` to `.gitignore` and to recovery's backup-exclusion list.

**Defer:**

- Phase 2 migration of existing `.env` / `nova:config:*` toggles → separate plan after v1 is stable.
- Phase 3+ multi-tenant + multi-env → tied to SaaS launch.
- Flagsmith migration evaluation → revisit when first SOC2-driven gap appears.

---

## Decision required from user

Before producing the plan document, please ratify or amend:

1. **Continue DIY?** (vs Flagsmith now / flagd / Unleash). Memo recommends **DIY**.
2. **Block v1 on the five §6 fixes?** Memo recommends **yes** — three are correctness (SR3, B1, S4), two are forensic (S1, CI1).
3. **SDK location**: ratify `nova-worker-common/` (where it landed) or revert to spec's `nova-contracts/`? Memo's tentative lean is **`nova-contracts/`** to match spec rationale.
4. **`selfmod.*` / `sandbox.*` exclusion from v1**: confirm OK to leave on env-var gate.
5. **Migration coordination with sec-006a / sec-006b**: confirm flags-001 doesn't merge until 082 lands and 083 is verified uncontested.

Once approved, the plan-phase produces a TDD-shaped task list that mirrors the existing `2026-05-05-feature-flags-v1.md` plan structure, adds the role-blocker tasks, and trims the bits that the security advisor blocked.
