# Phase 0 Audit Backlog — 2026-04-16

Synthesized from the nine axis reports in this folder. **Default sort: Severity (P0 first) → Daily-Driver Impact (H first) → Effort (S first).** Top rows are the obvious "do these first" items; bottom rows are P3 nice-to-haves.

## How to use this

- Drive Phase 1 planning directly from this table — rows marked **P0 / H / S** are the best candidates (biggest impact for least effort).
- **Severity** rates the defect against any neutral user. **Daily-Driver Impact** rates it specifically against Jeremy's intended daily-driver use (chat, memory, cortex, scheduling).
- A finding can be **P0 / L-impact** (severe but affects a rarely-used feature) or **P2 / H-impact** (minor but hits every session).
- **Effort:** S = ≤1 day, M = 2–5 days, L = > 5 days or requires its own design.
- Security findings reference `security.md`, which is **local-only** (gitignored). Titles here are safe to read publicly; full detail stays on this machine.

## Totals

- **Total findings:** 130 (114 defect findings + 16 nova-suite port recommendations)
- **By severity:** P0=23, P1=41, P2=50, P3=16
- **By effort:** S=74, M=45, L=11
- **By impact:** H=45, M=60, L=25
- **Quickest high-impact wins (P0+P1 with H-impact and S-effort):** ~22 items
- **Local-only (security report):** 20 findings

## Top 10 — drives Phase 1 planning

These rise to the top of the sort because they're severe, high-impact for daily-driver use, and each is small-to-medium effort.

1. **REL-001** — Reaper infinite-loops on `task_running → queued` (state machine rejects transition) — actively spamming errors on your running stack right now
2. **PERF-001** — ~~`/engrams/context` takes 6–14s on every chat turn~~ **Resolved 2026-04-18** — stale Ollama URL was root cause; current latency ~150ms typical
3. **PERF-002** — Embeddings falling back to cloud Gemini every call (`inference.backend=none`) — root cause of PERF-001 and PERF-003, also a privacy leak
4. **AQ-001** — Critique agents fail-open on JSON parse errors — weaker models get more-permissive pipeline (backwards)
5. **AQ-002** — Outcome feedback only reinforces positive engrams; bad engrams never lose activation (one-sided learning loop)
6. **OPS-001** — Health-check cascade: 3s inner timeout == outer timeout → three services flip to "degraded" from one slow probe
7. **SEC-001** — Orchestrator has rw mount `/:/host-root:rw` + bypassable shell denylist = host-level RCE-by-design
8. **SEC-005** — Default admin secret `nova-admin-secret-change-me` and Postgres password survive non-wizard install path
9. **REL-002** — ~~Backups silently exclude `/data/sources/` filesystem blobs — restore produces broken memory~~ **Resolved 2026-04-20** — recovery-service + scripts now roundtrip sources/ alongside the DB dump
10. **FC-012** — Triggers/scheduler: goal-level cron works, but no UI picker, no generalized trigger abstraction — Jeremy's explicit callout

---

## Backlog

### Security (local-only — see `security.md` for detail)

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| SEC-001 | security | Orchestrator `/:/host-root:rw` mount + sandbox `root` tier | P0 | H | M | Done |
| SEC-002 | security | Shell-command blocklist is substring-match, trivially bypassed | P0 | H | S | Done |
| SEC-003 | security | LLM-gateway `/v1/chat/completions` unauthenticated on all interfaces | P0 | H | M | Done |
| SEC-004 | security | Memory-service and cortex expose all endpoints with no auth | P0 | H | S | Done |
| SEC-005 | security | Default admin secret + Postgres password survive non-wizard install | P0 | H | S | Done |
| SEC-006 | security | Recovery-service writable `.env` mount + docker socket (`:ro` is cosmetic) — bigger than initially scoped; split into SEC-006a (migrate secrets out of .env) + SEC-006b (docker-socket-proxy for SDK path) | P0 | M | M | Split |
| SEC-007 | security | Google OAuth flow lacks CSRF `state` parameter | P1 | M | S | Open |
| SEC-008 | security | Chat-api WebSocket has no Origin validation | P1 | H | S | Open |
| SEC-009 | security | API keys hashed with unsalted SHA-256 | P1 | M | M | Open |
| SEC-010 | security | Telegram webhook lacks secret-token validation | P1 | L | S | Open |
| SEC-011 | security | Recovery-service public endpoints disclose topology/DB size/backups | P1 | M | S | Open |
| SEC-012 | security | Dashboard stores admin secret in `localStorage` | P2 | M | M | Open |
| SEC-013 | security | `X-On-Behalf-Of` trusted as user id when bridge secret matches | P2 | L | M | Open |
| SEC-014 | security | Admin-secret comparison not constant-time (`==` vs `compare_digest`) | P2 | L | S | Open |
| SEC-015 | security | `_get_require_auth` silent fallback to `.env` at DEBUG only | P2 | M | S | Open |
| SEC-016 | security | JWT secret auto-generation race on first boot (`ON CONFLICT DO UPDATE`) | P2 | L | S | Open |
| SEC-017 | security | `validate_url` misses IPv6 ranges + DNS-rebinding | P3 | L | M | Open |
| SEC-018 | security | `LOG_LEVEL=DEBUG` can leak DSN/credentials in stacktraces | P3 | L | S | Open |
| SEC-019 | security | Bridge-to-orchestrator admin secret defaults diverge (`changeme` vs `…-change-me`) | P3 | L | S | Open |
| SEC-020 | security | Vaultwarden profile defaults `SIGNUPS_ALLOWED=true` | P3 | L | S | Open |

### Privacy & data custody

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| PRIV-001 | privacy | No engram deletion endpoint — "forget this" is impossible | P0 | H | M | Done |
| PRIV-002 | privacy | Orchestrator mounts host `/:/host-root:rw` (privacy angle of SEC-001) | P0 | H | M | Done |
| PRIV-003 | privacy | Factory reset ignores ~90% of user data (engrams, intel, knowledge, conversations, cortex, friction…) | P0 | M | M | Done |
| PRIV-004 | privacy | Backups unencrypted plaintext; include `JWT_SECRET`, OAuth tokens, every message/memory | P1 | M | M | Open |
| PRIV-005 | privacy | Filesystem-stored sources orphaned on `delete_source` | P1 | M | S | Open |
| PRIV-006 | privacy | All engrams/sources/knowledge tied to single hardcoded tenant UUID (multi-user would silently merge) | P1 | L | L | Done |
| PRIV-007 | privacy | No user-data export; no user-deletion endpoint | P1 | M | M | Open |
| PRIV-008 | privacy | Unbounded growth on intel/knowledge/engrams (no retention knobs) | P1 | M | M | Open |
| PRIV-009 | privacy | Classifier + complexity-classifier log first-50-chars of prompts at DEBUG | P2 | M | S | Open |
| PRIV-010 | privacy | Intel worker `User-Agent: Nova-Intel/1.0` fingerprints every Nova install | P2 | L | S | Open |
| PRIV-011 | privacy | Friction-log screenshots persist on disk after parent task delete | P2 | L | S | Open |
| PRIV-012 | privacy | Cloudflare Tunnel profile silently MITMs all traffic (plaintext at CF edge) | P2 | M | S | Open |
| PRIV-013 | privacy | No per-message provider badge — user can't see which cloud saw a given prompt | P3 | M | S | Open |

### Reliability & data integrity

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| REL-001 | reliability | Reaper infinite-loops because `task_running → queued` rejected by state machine (9 live tasks stuck) | P0 | H | S | Done |
| REL-002 | reliability | `make backup` / recovery backup exclude `/data/sources/` — restore produces broken memory | P0 | H | S | Done |
| REL-003 | reliability | Engram ingestion `BRPOP` removes payload before decomposition — crash = lost memory | P0 | M | M | Done |
| REL-004 | reliability | Memory-service + llm-gateway leak Redis connections on shutdown (violates CLAUDE.md rule) | P1 | M | S | Open |
| REL-005 | reliability | Factory-reset `CATEGORY_TABLES` references 5 non-existent tables — partial resets silently succeed | P1 | M | S | Done |
| REL-006 | reliability | Migration idempotency not CI-verified; gap at 042/043; data-transform migrations lack guards | P1 | L | M | Open |
| REL-007 | reliability | `memory-service/schema.sql` is unversioned monolith; re-runs `DROP TABLE IF EXISTS …` every boot | P1 | M | M | Open |
| REL-008 | reliability | 99% of live engrams have NULL `source_ref_id` (provenance aspirational, not enforced) | P1 | M | M | Open |
| REL-009 | reliability | Consolidation mutex is `asyncio.Lock` — breaks if service ever scales to multi-worker | P2 | L | S | Open |
| REL-010 | reliability | Stale `nova:config:*` Redis keys survive container recreation; no reconcile endpoint/UI | P2 | M | S | Open |
| REL-011 | reliability | `_apply_adaptive_skips` mutates shared checkpoint dict; racy if pipeline retries race | P2 | L | S | Open |
| REL-012 | reliability | Heartbeat TTL (120s) ≈ stale threshold (150s); long LLM calls can trigger false-positive reap | P2 | M | S | Open |
| REL-013 | reliability | `tasks.output = COALESCE($4, output)` can overwrite real output with empty preview | P3 | L | S | Open |
| REL-014 | reliability | `_backfill_outcome_scores` full-scans `usage_events` on every pipeline completion (no expression index) | P3 | M | S | Open |

### Agent quality

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| AQ-001 | agent-quality | Critique agents fail-open on JSON parse errors (weaker models = more permissive pipeline) | P0 | H | S | Done |
| AQ-002 | agent-quality | Outcome feedback only reinforces positive; bad engrams never lose activation | P0 | H | S | Done |
| AQ-003 | agent-quality | Guardrail findings not actionable — no `guardrail_refactor` loop, medium-severity tainted output ships | P0 | H | M | Done |
| AQ-004 | agent-quality | `think_json` schema-validation failure returns raw dict; executor defaults (`.get("verdict","pass")`) are all permissive | P0 | H | S | Done |
| AQ-005 | agent-quality | Self-Model Update (consolidation Phase 6) is a stub — only counts engrams, never updates self-model | P1 | M | M | Open |
| AQ-006 | agent-quality | `what_do_i_know` tool schema advertises `query` param that is ignored | P1 | M | S | Open |
| AQ-007 | agent-quality | Cortex goal-skip detection uses fragile substring `"skip" in plan.lower()[:20]` | P1 | M | S | Open |
| AQ-008 | agent-quality | Web-fetched content injected verbatim into tool-result context (prompt-injection surface) | P1 | H | M | Open |
| AQ-009 | agent-quality | 112-line hardcoded `_build_self_knowledge()` prompt will drift from reality | P1 | M | M | Open |
| AQ-010 | agent-quality | Prompt caching only applied to Anthropic models — other providers pay full cost every turn | P2 | M | M | Open |
| AQ-011 | agent-quality | Memory seed source-type multipliers hardcoded (`chat=1.5, intel=0.5, knowledge=0.7, …`) | P2 | M | S | Open |
| AQ-012 | agent-quality | `_mark_engrams_used` unwired for `memory_retrieval_mode="tools"` — Neural Router training stops | P2 | M | M | Open |
| AQ-013 | agent-quality | Tool rule regex no create-time validation; invalid regex silently disables the rule | P2 | L | S | Open |
| AQ-014 | agent-quality | Hardcoded classifier model preference list + tier routing stale (qwen2.5:1.5b, cerebras/llama3.1-8b) | P2 | M | M | Open |
| AQ-015 | agent-quality | Cortex skip-counter persisted to module dict AND DB — minor dup, DB wins on restart | P3 | L | S | Open |
| AQ-016 | agent-quality | Context compaction has no fallback if LLM call fails; exception swallowed, verbose state retained | P3 | L | S | Open |

### Feature completeness

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| FC-001 | feature-completeness | Multi-user auth plumbing uses single hardcoded tenant UUID — adding family silently merges graphs | P0 | L | L | Done |
| FC-002 | feature-completeness | Consolidation runs but higher-order phases produce zeros (`schemas_created=0`, `edges_strengthened=0`) | P1 | M | M | Open |
| FC-003 | feature-completeness | Knowledge-worker profile-gated off by default; only 3 engrams with knowledge provenance | P1 | M | S | Open |
| FC-004 | feature-completeness | Cortex cost rollup shows `cost_so_far_usd=0.0` on active goals (March fix may be incomplete) | P1 | M | M | Open |
| FC-005 | feature-completeness | Cortex maturation pipeline in schema/filter but no drive implements transitions | P1 | M | M | Open |
| FC-006 | feature-completeness | Slack chat bridge claimed in CLAUDE.md, only Telegram adapter exists | P1 | M | M | Open |
| FC-007 | feature-completeness | Telegram bridge reported broken on `feature/unified-chat-pwa` branch — main status uncertain | P1 | H | M | Open |
| FC-008 | feature-completeness | Voice service: CLAUDE.md claims Deepgram/ElevenLabs, only OpenAI providers exist | P2 | L | S | Open |
| FC-009 | feature-completeness | Self-Modification scaffolding present; actual workflow not verified end-to-end | P2 | L | M | Open |
| FC-010 | feature-completeness | Skills table empty; framework shipped but no content seeded | P3 | M | S | Open |
| FC-011 | feature-completeness | No pluggable memory interface or benchmark — engram complexity unvalidated vs. markdown/vector alternatives ([design](../../designs/2026-04-18-pluggable-memory-and-benchmarks.md)) | P2 | M | L | Open |

### UI/UX

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| UX-001 | ui-ux | 5 first-impression pages (Expired, Invite, StartupScreen, AuthGate loader, Onboarding) bypass design system entirely | P1 | H | S | Open |
| UX-002 | ui-ux | Tab persistence half-shipped — AIQuality, Tasks (detail+filters), Goals use bare `useState` | P1 | H | S | Open |
| UX-003 | ui-ux | Chat-only mobile PWA incomplete — MobileModelChip, long-press tooltip, maskable icon, Nova teal all missing | P1 | M | S | Open |
| UX-004 | ui-ux | PWA manifest + HTML missing Apple mobile-web-app meta tags + correct theme color | P2 | M | S | Open |
| UX-005 | ui-ux | Loading / empty / error states inconsistent across pages (Skeleton sometimes, "Loading…" strings elsewhere, no error branches on some) | P2 | M | M | Open |
| UX-006 | ui-ux | Non-chat pages have minimal responsive adaptation; 768–1024px tablet viewports unhandled | P2 | L | S | Open |
| UX-007 | ui-ux | A11y thin — Tabs missing ARIA roles, Modal missing focus trap, IME-unsafe Enter in ChatInput, low-contrast `/60` timestamps | P2 | M | M | Open |
| UX-008 | ui-ux | Sidebar nav diverges from spec; `/editor` vs `/editors` lead to different pages via redirects | P2 | M | S | Open |
| UX-009 | ui-ux | Skills/Rules standalone pages dead code (redirect to Settings→Behavior); bundle bloat | P2 | L | S | Open |
| UX-010 | ui-ux | Mid-session service failure shows blank areas — no global "connection lost" banner | P2 | M | M | Open |
| UX-011 | ui-ux | Text-size (compact/medium/large) not in Appearance settings; uses hardcoded class maps instead of CSS var | P3 | L | S | Open |
| UX-012 | ui-ux | Onboarding wizard is pre-redesign 6-step; spec's 7-step Identity-aware flow not shipped | P3 | L | M | Open |
| UX-013 | ui-ux | Dead / duplicate pages (`MCP.tsx` unimported; `Skills.tsx`/`Rules.tsx` orphaned) | P3 | L | S | Open |

### Performance

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| PERF-001 | performance | `/api/v1/engrams/context` takes 6–14s per call — blocks every chat message (audit bug — actual latency is ~150ms typical after stale Ollama URL cleanup on 2026-04-18, occasional 1–2s spikes from Ollama queue contention) | P0 | H | M | Resolved |
| PERF-002 | performance | Embeddings fall back to cloud Gemini on every call (Ollama stopped, routing `cloud-only`) | P0 | H | M | Done |
| PERF-003 | performance | Consolidation cycles run 65–110s, hold a single AsyncSession, starve chat (DB session fix 2026-04-21 e64ead0; user-idle gate 2026-04-21 closes Ollama queue contention by skipping LLM phases 2+2.5 when user chatted within 5m) | P0 | M | L | Done |
| PERF-004 | performance | Spreading-activation recursive CTE missing tenant filter on recursive step; `OR` join won't scale | P1 | L | S | Open |
| PERF-005 | performance | Dashboard main bundle 2.9 MB; only 2 of ~20 routes are `React.lazy()` | P1 | H | S | Open |
| PERF-006 | performance | Topic regeneration parses embeddings via Python `float()` per component (should batch/binary) | P1 | M | S | Open |
| PERF-007 | performance | `fields=minimal` designed but not implemented — Brain ships full payload every load | P1 | M | S | Open |
| PERF-008 | performance | Postgres on out-of-box defaults (`shared_buffers=128MB`, `work_mem=4MB`) — latent at 50K+ engrams | P1 | M | S | Open |
| PERF-009 | performance | MCP server spawn adds ~22s to orchestrator cold start (puppeteer blocks readiness) | P2 | M | S | Open |
| PERF-010 | performance | `retrieval_log` grows unbounded (21 MB already, no TTL / cleanup) | P2 | L | S | Open |
| PERF-011 | performance | Neural Router precision@20 = 1.0 on consecutive runs — label leakage, not learning | P2 | M | M | Open |
| PERF-012 | performance | `assemble_context` serializes independent section fetchers — no `asyncio.gather` | P2 | H | S | Open |
| PERF-013 | performance | `memory-service` steady-state RSS 606 MB; eager import of sklearn/umap/torch at startup | P3 | L | S | Open |

### Infra & ops

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| OPS-001 | infra-ops | Health-check cascade: 3s inner timeout == 3s outer timeout → three services flip to "degraded" | P0 | H | S | Done |
| OPS-002 | infra-ops | Redis connection leaks in 5+ modules (memory-service `embedding`, llm-gateway `discovery`/`registry`, cortex `budget`, orchestrator `stimulus`) | P0 | M | S | Done |
| OPS-003 | infra-ops | No pre-flight Docker network check in `setup.sh` (2026-03-28 incident class) | P1 | M | S | Open |
| OPS-004 | infra-ops | 4 services (cortex, intel-worker, knowledge-worker, recovery) use `logging.basicConfig` — breaks cross-service tracing | P1 | M | S | Open |
| OPS-005 | infra-ops | No metrics / tracing / request-duration observability anywhere | P1 | M | M | Open |
| OPS-006 | infra-ops | `.env.example` missing ~25 variables Compose references (all Cortex tunables, all vLLM vars, backup dirs) | P1 | M | S | Open |
| OPS-007 | infra-ops | Runtime Redis config can stale-override `platform_config` silently; no reconcile / diff UI | P1 | M | M | Open |
| OPS-008 | infra-ops | Critical log lines at DEBUG in cortex (lesson ingestion, goal.completed stimulus, budget paused stimulus) | P2 | M | S | Open |
| OPS-009 | infra-ops | Ollama auto-detect probe runs from host shell, not container — WSL2 + Windows-host Ollama fails at runtime | P2 | L | S | Open |
| OPS-010 | infra-ops | `backup.sh` omits `data/sources/`; `restore.sh` doesn't pause writers | P2 | M | S | Open |
| OPS-011 | infra-ops | `make prune` uses bare `docker system prune -f` — clobbers other Docker projects' containers | P2 | M | S | Open |
| OPS-012 | infra-ops | `neural-router-trainer` with `restart: unless-stopped` and no data-gate → respawn loop on fresh install | P2 | L | S | Open |
| OPS-013 | infra-ops | Dashboard depends only on recovery; comes up before backends → "looks fine" UX while chat is dead | P3 | M | S | Open |
| OPS-014 | infra-ops | Orchestrator host-root mount prevents user-namespace / read-only-rootfs future hardening | P3 | L | L | Open |

### Nova-suite feature ports (inventory axis)

| # | Axis | Finding | Sev | Impact | Effort | Status |
|---|---|---|---|---|---|---|
| NSI-001 | nova-suite | Port scheduled-triggers data model (`cron_expression` + XOR `{tool,input}`/`{goal}`) + patch-first firing + chat CRUD | P1 | H | M | Open |
| NSI-002 | nova-suite | Port chat-driven tool CRUD with conversation-level pending-tool-call confirmation (generalizable safety pattern) | P1 | M | M | Open |
| NSI-003 | nova-suite | Port unified Run/Activity feed with `trigger_type` — one "what did Nova do today?" surface | P1 | M | M | Open |
| NSI-004 | nova-suite | Port scheduler-triggers Settings panel (read-only, `cronToHuman` formatter) | P2 | H | S | Open |
| NSI-005 | nova-suite | Port conversation `pending_tool_call` JSONB + 30min expiry + regex yes/no parsing | P2 | M | S | Open |
| NSI-006 | nova-suite | Port spec for `nova.system_health` + `nova.daily_summary` scheduled self-check tools | P2 | M | M | Open |
| NSI-007 | nova-suite | Skip — `describe_tools`/`describe_config` (Nova's MCP introspection already richer) | P3 | L | S | Open |
| NSI-008 | nova-suite | Skip — agent-loop architecture (Nova's Quartet pipeline supersedes) | P3 | L | S | Open |
| NSI-009 | nova-suite | Skip — local+fallback LLM provider pattern (Nova's llm-gateway + LiteLLM richer) | P3 | L | S | Open |
| NSI-010 | nova-suite | Port spec (not code) for Home Assistant integration via MCP server rather than hand-coded tools | P2 | L | L | Open |
| NSI-011 | nova-suite | Skip — raw shell/fs/http tools (Nova's MCP pattern safer) | P3 | L | S | Open |
| NSI-012 | nova-suite | Port partial — Event `correlation_id` + durable event log + `Approval` model as task sibling | P2 | M | M | Open |
| NSI-013 | nova-suite | Skip — seed-on-startup upsert pattern (Nova's migration-driven approach safer) | P3 | L | S | Open |
| NSI-014 | nova-suite | Skip for now — Board/Kanban UI (half-shipped; redesign against engram-backed tasks if priority) | P3 | L | L | Open |
| NSI-015 | nova-suite | Skip — n8n/Windmill workflow adapter (Nova's MCP covers same ground) | P3 | L | M | Open |
| NSI-016 | nova-suite | Skip — deployment onboarding assistant (Nova's setup.sh handles MVP) | P3 | L | L | Open |

---

## Cross-axis clusters worth noting

Groups of findings that share a root cause — fixing one often unlocks several. Useful for Phase 1 batching.

1. **The `/host-root:rw` mount and sandbox privilege model** — SEC-001, SEC-002, SEC-006, PRIV-002, OPS-014 all trace to one compose-level mount + one substring-denylist. Single medium-effort redesign neutralizes six findings.
2. **Ollama is stopped → cloud fallback everywhere** — PERF-002, PERF-001 (downstream), PERF-003 (downstream), PRIV-013 (per-turn visibility), OPS-007 (stale Redis config). If Ollama comes back online, three P0 performance findings shrink dramatically and one privacy finding softens.
3. **Engram source provenance + deletion + retention** — REL-008, PRIV-001, PRIV-005, PRIV-007, PRIV-008 form a single "user controls their memory" story. A Phase 1 feature that adds `DELETE /engrams/{id}`, `POST /forget`, and retention knobs closes all five.
4. **Pipeline fail-open posture** — AQ-001, AQ-003, AQ-004 are three different expressions of the same "when in doubt, ship it" bias in the pipeline. Symmetric fix across all three is one focused refactor.
5. **Health-rollup cascade + Redis connection hygiene** — OPS-001 and OPS-002 are mechanical one-day fixes that eliminate a whole class of ambient noise and let the rest of the audit be done "quietly."
6. **Factory reset + backup integrity** — PRIV-003, REL-002, REL-005 all mean "recovery UX promises something it doesn't deliver." Three file changes close the loop.
7. **Triggers / scheduler** — FC-012, NSI-001, NSI-004 are the shape of the one feature Jeremy explicitly asked about. NSI-001 is the design to adopt, FC-012 is the shipped-but-incomplete bridge to close.

---

## Killed / explicitly-skipped

Intentionally empty at Phase 0 close — nothing has been killed yet. As Phase 1 planning progresses, findings deferred indefinitely (or rejected after discussion) should be moved here with a one-line reason so future audits don't re-flag them.

---

## Post-Phase-0 follow-ups

Items surfaced during Phase 1+ execution that weren't in the original audit. Tracked here so they don't fall through the cracks.

| # | Surfaced in | Finding | Sev | Status |
|---|---|---|---|---|
| FU-001 | Phase 1.2 sprint | Chat appears broken over Tailscale (user-reported 2026-04-17). **Root cause: 24h Redis TTL on `nova:agent:{id}` records silently expired the primary agent; `list_agents()` then returned `[]` and `POST /api/v1/chat/stream` 503'd with "No agents available — Nova is still starting up".** Not Tailscale-specific — affected all chat access once Nova had been running for a day. Fixed by removing the TTL in `orchestrator/app/store.py` (3 sites). | P0 | Done |
| FU-003 | FC-001 close (2026-04-21) | Cortex runs as a single global brain — no tenant concept. Per Q1=C in the FC-001 design, deferred to a future audit item. When the second tenant is added, decide whether cortex stays global (household-assistant model) or gets per-tenant instances. | P2 | Open |
| FU-004 | FC-001 close (2026-04-21) | `tenant_id` still missing on `pods`, `pod_agents`, `tasks`, `mcp_servers`, `friction_log`, `activity_events`, `skills`, `rules`, `selfmod_prs`, pipeline artifacts (`artifacts`, `code_reviews`, `guardrail_findings`, `pipeline_training_logs`). FC-001 scope was the memory/knowledge merging risk; these remain instance-global. Add before multi-user rollout if any of them should be per-tenant. | P1 | Open |
| FU-005 | FC-001 close (2026-04-21) | `knowledge_router` admin credential endpoints (create/delete/validate) and crawl-log ingest still hardcode `DEFAULT_TENANT_ID` — admin paths without user context. Needs body-level `tenant_id` param once multi-tenant credentials actually exist. | P2 | Open |
| FU-006 | FC-001 close (2026-04-21) | Memory-service diagnostic endpoints (`/reconstruct`, `/graph`, `/user-profile`, `/engrams/{id}`, `/correct`, `/topics`, `/batch`) don't yet accept or filter by `tenant_id`. Admin-only paths so not a leak today; tighten before multi-tenant rollout. | P2 | Open |
| FU-007 | FC-001 close (2026-04-21) | Pipeline ingestion paths don't carry tenant: `orchestrator/app/quality_router.py:236` (benchmark harness) and `orchestrator/app/pipeline/agents/post_pipeline.py:107` (post-pipeline extraction) push to the engram queue without `tenant_id`. Fix when pipeline state adopts tenant context. | P2 | Open |
| FU-008 | FC-001 close (2026-04-21) | Flip memory-service endpoint grace-period default from WARN to strict 400 once all callers have been audited silent for a sustained period. Target: one clean week of logs with zero "called without tenant_id" WARNs. | P1 | Open |
| FU-002 | Phase 1.2 sprint | Remove Claude subscription auth method (`claude_subscription_provider.py`). Anthropic **explicitly prohibited** third-party OAuth use as of Feb 19 2026; enforcement started Jan 2026 (sources: Claude Code legal-compliance page, The Register). Running the provider against api.anthropic.com with a Max/Pro token is an active ToS violation. Silently downgraded Sonnet 4.6 → Haiku 4.5 anyway. **Removed** in commit ca9b40e: provider file deleted, all claude-max/* registry/discovery/config references scrubbed, setup-wizard option removed, migration 059 cleans stale routing-map entries. | P0 | Done |
| FU-009 | SEC-006a design (2026-05-05) | Dashboard updates to LLM provider keys / chat-bridge tokens / GitHub PAT require a service restart — the new `platform_secrets` store has no change-notification mechanism, services cache resolved values at request time but won't repick on update. Add Redis pubsub channel (e.g. `nova:secrets:invalidate`) or polling-based cache TTL so gateway/chat-bridge/orchestrator hot-reload without restart. UX warning already shown in `ProviderStatusSection.tsx`, so the limitation is visible. | P2 | Open |

---

## Re-audit strategy

Re-run this audit annually (or after any structural change: new services, major pipeline redesign, multi-user rollout). Create a new dated folder `docs/audits/YYYY-MM-DD-phaseN/` and diff `BACKLOG.md` against this baseline to measure whether the security/reliability/agent-quality posture improved over time.
