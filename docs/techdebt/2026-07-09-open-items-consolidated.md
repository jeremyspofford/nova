# Open Items — Consolidated Checklist (2026-07-09)

> Single actionable view of still-open pain points / bad designs / insecure code,
> pulled from three sources:
> - `docs/techdebt/2026-07-07-code-audit-findings.md` (round 1) — **current**
> - `docs/techdebt/2026-07-07-code-audit-round2.md` — **current**
> - `docs/audits/2026-04-16-phase0/BACKLOG.md` — **~3 months stale**
> - `docs/audits/2026-05-03-readiness-assessment.md` — the M11 approval seam
>
> **⚠️ Staleness warning.** The Phase-0 backlog predates the engram→OKF-markdown
> memory migration and the entire `feature/safe-defaults` line. Rows tagged
> **`[verify]`** touch subsystems that have since been rewritten (engrams, memory
> retrieval, neural router, spreading-activation) or shipped adjacent fixes — treat
> them as "re-confirm before working," not confirmed-live. Rows without the tag are
> either fresh (the two July-07 audits) or structurally unlikely to have changed.
>
> Effort: S = ≤1 day · M = 2–5 days · L = >5 days or needs its own design.

---

## A. Fresh techdebt — deferred by choice (from the July-07 audits)

These are current, verified, and deliberately parked — not stale.

- [ ] **TD-02** · Med · Perf — Per-tool-call `httpx.AsyncClient` (no pooling, ignores shared factory). *Land with Phase 3 consolidation so services aren't re-plumbed twice.* (S–M)
- [ ] **TD-05** · Low · Duplication — Redis-client logic copy-pasted across 7+ service homes; no shared `nova_worker_common` module. *Same Phase 3 window.* (M)
- [ ] **TD-15** · Low · Maintainability — `dashboard/src/pages/Models.tsx` is 1429 lines w/ duplicated recommendation-card markup. *Pure refactor; schedule with regression headroom.* (M)
- [ ] **TD-01 residual** · High · Security — SSRF validator shipped, but the **connect-time IP-pin transport (TOCTOU close)** was deferred. Resolve-and-check closes the common case; the pin closes the race. (M)

---

## B. Readiness assessment — the M11 seam

- [ ] **RA-01** `[verify]` · High — Approved MUTATE actions may not auto-execute the pending tool (`decide_approval` flips status and stops; no resume worker). **Likely closed** — the approval-worker resume path shipped with human-checkpoints (2026-07-06); confirm the MUTATE/consent path specifically, not just checkpoints. Also check the FIXME `provider_kind="github"` hardcode and `DEFAULT_TENANT`. (M)

---

## C. Security (Phase-0, local detail in gitignored `security.md`)

- [ ] **SEC-007** · P1 · Google OAuth flow lacks CSRF `state` parameter (S)
- [ ] **SEC-008** · P1 · Chat-api WebSocket has no Origin validation (S)
- [ ] **SEC-009** · P1 · API keys hashed with unsalted SHA-256 (M)
- [ ] **SEC-010** · P1 · Telegram webhook lacks secret-token validation (S) — *only if Telegram lands (see FC-007)*
- [ ] **SEC-011** · P1 · Recovery-service public endpoints disclose topology / DB size / backups (S)
- [ ] **SEC-012** · P2 · Dashboard stores admin secret in `localStorage` (M)
- [ ] **SEC-013** · P2 · `X-On-Behalf-Of` trusted as user id when bridge secret matches (M)
- [ ] **SEC-014** · P2 · Admin-secret comparison not constant-time (`==` vs `compare_digest`) (S)
- [ ] **SEC-015** · P2 · `_get_require_auth` silent fallback to `.env` at DEBUG only (S)
- [ ] **SEC-016** · P2 · JWT secret auto-generation race on first boot (`ON CONFLICT DO UPDATE`) (S)
- [ ] **SEC-017** · P3 · `validate_url` misses IPv6 ranges + DNS-rebinding — *overlaps TD-01; may be fully closed by the SSRF work* `[verify]` (M)
- [ ] **SEC-018** · P3 · `LOG_LEVEL=DEBUG` can leak DSN/credentials in stacktraces (S)
- [ ] **SEC-019** · P3 · Bridge↔orchestrator admin-secret defaults diverge (`changeme` vs `…-change-me`) (S)
- [ ] **SEC-020** · P3 · Vaultwarden profile defaults `SIGNUPS_ALLOWED=true` — *Vaultwarden was dropped per memory; likely moot* `[verify]` (S)

## D. Privacy & data custody

- [ ] **PRIV-004** · P1 · Backups unencrypted plaintext; include `JWT_SECRET`, OAuth tokens, every message/memory (M)
- [ ] **PRIV-005** · P1 · Filesystem-stored sources orphaned on `delete_source` (S)
- [ ] **PRIV-007** · P1 · No user-data export; no user-deletion endpoint (M)
- [ ] **PRIV-008** · P1 · Unbounded growth on intel/knowledge/memory (no retention knobs) — *45-day journal backstop now exists; re-scope to intel/knowledge* `[verify]` (M)
- [ ] **PRIV-009** · P2 · Classifier + complexity-classifier log first-50-chars of prompts at DEBUG (S)
- [ ] **PRIV-010** · P2 · Intel worker `User-Agent: Nova-Intel/1.0` fingerprints every install (S)
- [ ] **PRIV-011** · P2 · Friction-log screenshots persist on disk after parent task delete (S)
- [ ] **PRIV-012** · P2 · Cloudflare Tunnel profile silently MITMs all traffic (plaintext at CF edge) (S)
- [ ] **PRIV-013** · P3 · No per-message provider badge — user can't see which cloud saw a prompt (S)

## E. Reliability & data integrity

- [ ] **REL-004** · P1 · memory-service + llm-gateway leak Redis connections on shutdown (violates CLAUDE.md rule) — *partial OPS-002 overlap* `[verify]` (S)
- [ ] **REL-006** · P1 · Migration idempotency not CI-verified; gap at 042/043; data-transform migrations lack guards (M)
- [ ] **REL-007** · P1 · `memory-service/schema.sql` unversioned monolith; `DROP TABLE IF EXISTS` every boot — *OKF backend has no Postgres now; likely moot* `[verify]` (M)
- [ ] **REL-008** · P1 · 99% of engrams NULL `source_ref_id` — *engram-era; moot under OKF* `[verify]` (M)
- [ ] **REL-009** · P2 · Consolidation mutex is `asyncio.Lock` — breaks on multi-worker (S)
- [ ] **REL-010** · P2 · Stale `nova:config:*` Redis keys survive recreation; no reconcile endpoint/UI (S) — *dup of OPS-007*
- [ ] **REL-011** · P2 · `_apply_adaptive_skips` mutates shared checkpoint dict; racy on retry (S)
- [ ] **REL-012** · P2 · Heartbeat TTL (120s) ≈ stale threshold (150s) → false-positive reap on long LLM calls (S)
- [ ] **REL-013** · P3 · `tasks.output = COALESCE($4, output)` can overwrite real output with empty preview (S)
- [ ] **REL-014** · P3 · `_backfill_outcome_scores` full-scans `usage_events` per completion (no expression index) (S)

## F. Agent quality

- [ ] **AQ-005** · P1 · Self-Model Update (consolidation Phase 6) is a stub — only counts, never updates self-model `[verify]` (M)
- [ ] **AQ-006** · P1 · `what_do_i_know` tool schema advertises `query` param that is ignored (S)
- [ ] **AQ-007** · P1 · Cortex goal-skip detection uses fragile substring `"skip" in plan.lower()[:20]` (S)
- [ ] **AQ-008** · P1 · Web-fetched content injected verbatim into tool-result context (prompt-injection surface) — *`web_fetch_strict_sanitize` flag now exists; confirm coverage* `[verify]` (M)
- [ ] **AQ-009** · P1 · 112-line hardcoded `_build_self_knowledge()` prompt will drift from reality (M)
- [ ] **AQ-010** · P2 · Prompt caching only applied to Anthropic models — others pay full cost every turn (M)
- [ ] **AQ-011** · P2 · Memory seed source-type multipliers hardcoded `[verify]` (S)
- [ ] **AQ-012** · P2 · `_mark_engrams_used` unwired for `memory_retrieval_mode="tools"` — *engram-era* `[verify]` (M)
- [ ] **AQ-013** · P2 · Tool rule regex no create-time validation; invalid regex silently disables the rule (S)
- [ ] **AQ-014** · P2 · Hardcoded classifier model preference list + tier routing stale `[verify]` (M)
- [ ] **AQ-015** · P3 · Cortex skip-counter persisted to module dict AND DB — minor dup (S)
- [ ] **AQ-016** · P3 · Context compaction has no fallback if LLM call fails; exception swallowed (S)

## G. Feature completeness

- [ ] **FC-002** · P1 · Consolidation higher-order phases produce zeros (`schemas_created=0`, `edges_strengthened=0`) `[verify]` (M)
- [ ] **FC-003** · P1 · Knowledge-worker profile-gated off by default; thin knowledge provenance (S)
- [ ] **FC-004** · P1 · Cortex cost rollup shows `cost_so_far_usd=0.0` on active goals `[verify]` (M)
- [ ] **FC-005** · P1 · Cortex maturation pipeline in schema but no drive implements transitions — *maturation executor shipped per TODOS; likely resolved* `[verify]` (M)
- [ ] **FC-006** · P1 · Slack chat bridge claimed in docs, only Telegram adapter exists `[verify]` (M)
- [ ] **FC-007** · P1 · Telegram bridge reported broken; main status uncertain `[verify]` (M)
- [ ] **FC-008** · P2 · Voice: docs claimed Deepgram/ElevenLabs, only OpenAI exists — *CLAUDE.md now says OpenAI-only; likely resolved* `[verify]` (S)
- [ ] **FC-009** · P2 · Self-Modification scaffolding present; workflow not verified end-to-end (M)
- [ ] **FC-010** · P3 · Skills table empty; framework shipped but no content seeded `[verify]` (S)
- [ ] **FC-011** · P2 · No pluggable memory interface/benchmark — *OKF `MemoryBackend` is now exactly this; likely resolved* `[verify]` (L)

## H. UI/UX

- [ ] **UX-001** · P1 · 5 first-impression pages (Expired, Invite, StartupScreen, AuthGate loader, Onboarding) bypass the design system (S)
- [ ] **UX-002** · P1 · Tab persistence half-shipped — AIQuality, Tasks, Goals use bare `useState` (S)
- [ ] **UX-003** · P1 · Chat-only mobile PWA incomplete (MobileModelChip, long-press tooltip, maskable icon, teal) (S)
- [ ] **UX-004** · P2 · PWA manifest + HTML missing Apple mobile-web-app meta tags + theme color (S)
- [ ] **UX-005** · P2 · Loading/empty/error states inconsistent across pages (M)
- [ ] **UX-006** · P2 · Non-chat pages minimal responsive adaptation; 768–1024px tablet unhandled (S)
- [ ] **UX-007** · P2 · A11y thin — Tabs missing ARIA, Modal no focus trap, IME-unsafe Enter, low-contrast timestamps (M)
- [ ] **UX-008** · P2 · Sidebar nav diverges from spec; `/editor` vs `/editors` split via redirects (S)
- [ ] **UX-009** · P2 · Skills/Rules standalone pages dead code (redirect to Settings→Behavior) (S)
- [ ] **UX-010** · P2 · Mid-session service failure shows blank areas — no global "connection lost" banner (M)
- [ ] **UX-011** · P3 · Text-size preset not in Appearance settings; hardcoded class maps (S)
- [ ] **UX-012** · P3 · Onboarding wizard is pre-redesign 6-step; 7-step Identity-aware flow not shipped (M)
- [ ] **UX-013** · P3 · Dead/duplicate pages (`MCP.tsx` unimported; `Skills.tsx`/`Rules.tsx` orphaned) (S)

## I. Performance

- [ ] **PERF-004** · P1 · Spreading-activation recursive CTE missing tenant filter; `OR` join won't scale — *engram-era* `[verify]` (S)
- [ ] **PERF-005** · P1 · Dashboard main bundle 2.9 MB; only 2 of ~20 routes `React.lazy()` (S)
- [ ] **PERF-006** · P1 · Topic regeneration parses embeddings via Python `float()` per component `[verify]` (S)
- [ ] **PERF-007** · P1 · `fields=minimal` designed but not implemented — Brain ships full payload `[verify]` (S)
- [ ] **PERF-008** · P1 · Postgres on out-of-box defaults (`shared_buffers=128MB`, `work_mem=4MB`) (S)
- [ ] **PERF-009** · P2 · MCP server spawn adds ~22s to orchestrator cold start (puppeteer blocks readiness) (S)
- [ ] **PERF-010** · P2 · `retrieval_log` grows unbounded (no TTL/cleanup) `[verify]` (S)
- [ ] **PERF-011** · P2 · Neural Router precision@20 = 1.0 — label leakage, not learning `[verify]` (M)
- [ ] **PERF-012** · P2 · `assemble_context` serializes independent section fetchers — no `asyncio.gather` (S)
- [ ] **PERF-013** · P3 · memory-service RSS 606 MB; eager import of sklearn/umap/torch at startup `[verify]` (S)

## J. Infra & ops

- [ ] **OPS-003** · P1 · No pre-flight Docker network check in installer (2026-03-28 incident class) (S)
- [ ] **OPS-004** · P1 · 4 services (cortex, intel-worker, knowledge-worker, recovery) use `logging.basicConfig` — breaks cross-service tracing (S)
- [ ] **OPS-005** · P1 · No metrics/tracing/request-duration observability — *Grafana/observability profile landed; re-scope to `/metrics` instrumentation* `[verify]` (M)
- [ ] **OPS-006** · P1 · `.env.example` missing ~25 Compose-referenced vars (Cortex tunables, vLLM, backup dirs) (S)
- [ ] **OPS-007** · P1 · Runtime Redis config can stale-override `platform_config` silently; no reconcile/diff UI (M)
- [ ] **OPS-008** · P2 · Critical cortex log lines at DEBUG (lesson ingestion, goal.completed, budget paused) — *some bumped to WARNING per TODOS* `[verify]` (S)
- [ ] **OPS-009** · P2 · Ollama auto-detect probe runs from host shell, not container — WSL2 + Windows-host fails (S)
- [ ] **OPS-010** · P2 · `backup.sh` omits `data/sources/`; `restore.sh` doesn't pause writers `[verify]` (S)
- [ ] **OPS-011** · P2 · `make prune` uses bare `docker system prune -f` — clobbers other Docker projects — *Makefile now has safe prune/prune-all; likely resolved* `[verify]` (S)
- [ ] **OPS-012** · P2 · `neural-router-trainer` respawn loop on fresh install (no data-gate) (S)
- [ ] **OPS-013** · P3 · Dashboard depends only on recovery; "looks fine" UX while chat is dead — *startup screen now exists; likely resolved* `[verify]` (S)
- [ ] **OPS-014** · P3 · Orchestrator host-root mount blocks user-namespace / read-only-rootfs hardening (L)

## K. Nova-suite ports (feature backlog, not defects — "Port" only)

- [ ] **NSI-001** · P1 · Scheduled-triggers data model (`cron` + XOR `{tool,input}`/`{goal}`) + patch-first firing + chat CRUD (M)
- [ ] **NSI-002** · P1 · Chat-driven tool CRUD with conversation-level pending-tool-call confirmation (M)
- [ ] **NSI-003** · P1 · Unified Run/Activity feed with `trigger_type` — one "what did Nova do today?" surface (M)
- [ ] **NSI-004** · P2 · Scheduler-triggers Settings panel (read-only, `cronToHuman`) (S)
- [ ] **NSI-005** · P2 · Conversation `pending_tool_call` JSONB + 30min expiry + regex yes/no parsing (S)
- [ ] **NSI-006** · P2 · Spec for `nova.system_health` + `nova.daily_summary` scheduled self-check tools (M)
- [ ] **NSI-010** · P2 · Spec (not code) for Home Assistant integration via MCP server (L)
- [ ] **NSI-012** · P2 · Event `correlation_id` + durable event log + `Approval` model as task sibling (M)

*(NSI-007/008/009/011/013/015/016 marked "Skip" in the backlog — excluded.)*

---

## Cross-axis clusters (fix-one-unlock-many, from Phase-0 §clusters)

1. **Engram provenance + deletion + retention** — REL-008, PRIV-005, PRIV-007, PRIV-008. *Partly overtaken by OKF; re-scope.*
2. **Triggers / scheduler** — FC-012 (bridge), NSI-001 (adopt this design), NSI-004. Jeremy's explicit callout.
3. **Backup integrity** — PRIV-004, OPS-010. "Recovery UX promises what it doesn't deliver."
4. **Redis connection hygiene** — REL-004, OPS-002 remnants. Mechanical one-day sweep.
5. **Pipeline fail-open posture** — mostly closed (AQ-001/003/004 done); AQ-008 (injection) remains.
