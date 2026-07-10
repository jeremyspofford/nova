# 04 — Feature Specification

> **Audit date:** 2026-07-05. Product core (confirmed by owner): the
> **autonomous brain** and the **memory-backed assistant** are co-equal
> critical pillars. Status values are code/runtime-verified.

Priority levels: **P0 critical** (the product is these) · **P1 important**
(platform won't be credible without) · **P2 nice-to-have**.

---

## P0 — Critical

### F1. Memory-backed chat assistant
**Story:** I chat with Nova; it remembers durable facts across sessions in
files I can read, edit, and git-track myself.
**Status: ✅ working.**
**Files:** `orchestrator/app/agents/runner.py`, `memory-service/app/backends/okf/*`,
`orchestrator/app/tools/memory_tools.py`, `chat-api/`, `dashboard/src/pages/Chat.tsx` + `chat/`.
**Verified behavior:** streaming with thinking/progress frames; sources
surfaced (memory files + web pages); exchange digests → journal; 5 memory
tools; `memory_retrieval_mode` inject|tools; fabricated-citation guard.
**Gaps:**
- Retrieval quality is bare BM25 with no evaluation loop actually tuning it
  (quality_loop has RetrievalTuningLoop registered; `quality_scores` is empty
  on a fresh host — unproven in practice).
- Journal → topics distillation depends on the nightly curation goal, which
  requires the brain toggle ON (default OFF). With brain off, only the 45-day
  archive backstop runs: **journals accumulate undistilled by default**. This
  coupling is easy to miss and undermines the memory pillar on brain-off
  installs.

### F2. Autonomous goal pursuit (Cortex)
**Story:** I define a goal; Nova matures it (triage→scope→spec→my review→
build→verify) and works it in background cycles within a budget.
**Status: 🟡 working core, known gaps.**
**Files:** `cortex/app/{loop,cycle}.py`, `drives/*`, `maturation/*`,
`goals_router.py`, dashboard Goals + maturation components.
**Verified behavior:** maturation pipeline **is wired** (contrary to the
previous audit); decomposition into child goals/tasks exists with 4 dedicated
test files; approach-dedup prevents oscillation; budget tiers published to
gateway; CI-triage stimulus fast path; zombie-goal sweep; adaptive cycle
interval; human review gate before building.
**Gaps (real, from code + TODOS.md):**
- **Learning from failures:** reflections are written to memory/DB but PLAN
  never queries them back — Nova can repeat known-bad approaches across goals
  (within-goal dedup exists).
- **No human checkpoint tool** for CAPTCHA/email verification (blocks
  unattended browser signups).
- Brain default-off + `CORTEX_DAILY_BUDGET_USD=5` are safe defaults, but
  there's no "first goal" onboarding that proves the loop to a new user.

### F3. Quartet pipeline execution
**Story:** any nontrivial work request runs through staged agents
(context→task→guardrail→code-review→critique→decision) with checkpoints,
retries, and cost caps.
**Status: ✅ working.**
**Files:** `orchestrator/app/pipeline/*`, `pipeline_router.py`, pods tables.
**Verified:** BRPOP queue + heartbeat + reaper; JSONB checkpoint resume
(crash-recovery tests exist); per-pod sandbox/cost/review policy; complexity
classifier routes stages to models; SSE notifications.
**Gaps:** executor is a 2,014-line monolith (maintainability, not behavior);
`pipeline_training_logs` collected but unused downstream.

### F4. Multi-provider LLM routing
**Story:** requests route to local or cloud models by strategy/availability;
I can swap inference backends from Settings without editing files.
**Status: ✅ working.**
**Files:** `llm-gateway/app/*`, recovery `inference/*`, dashboard
LocalInference + LLMRouting + ProviderStatus sections.
**Verified:** 13 providers; strategies local-first/only, cloud-first/only;
bundled containers (ollama/vllm/sglang/llamacpp) start/stop via recovery with
`inference.url` handshake; embed-provider override; WoL for a remote GPU box;
response cache; rate limits.
**Gaps:** ChatGPT-subscription provider needs a manual `codex login`;
model catalog quality varies by provider.

### F5. Admin dashboard
**Story:** every platform capability is operable from a web UI.
**Status: ✅ working** (32 pages, 33 settings sections — near-full API parity).
**Gap:** no generated TS types from Pydantic (drift risk).

### F6. Recovery & disaster tolerance
**Story:** backup/restore/factory-reset work even when the platform is down.
**Status: ✅ working** (verified live: backup API produced
`nova-backup-2026-07-06_00-26-28.tar.gz` during this audit).
**Files:** `recovery-service/*`, docker-socket-proxy, dashboard Recovery page.
**Gap:** `scripts/backup.sh` not executable → **`make backup` fails**
(the documented emergency CLI path is broken; API/UI paths work).

---

## P1 — Important

### F7. Capability platform: consent, credentials, audit
**Status: ✅ working** — consent rules, encrypted credentials, hash-chained
audit, approval queue + worker, watched repos; ~15 dedicated test files.
**Gap:** approval flow has no free-text human reply channel (needed by F2's
checkpoint gap).

### F8. Platform secrets (SEC-006a)
**Status: ✅ working** — encrypted at rest, first-boot `.env` mirror,
UI rotation with live hot-reload in the gateway (FU-009, 2026-07-10).
**Gaps:** `.env` mount still `:rw` pending FU-010.

### F9. Feature flags
**Status: ✅ working** — SDK + pubsub invalidation + partition-fallback cache +
public allowlist + CRITICAL_FLAGS confirm gate + audit metadata.

### F10. Auth / multi-user / RBAC
**Status: 🟡 working scaffolding** — JWT + Google OAuth + API keys + invites +
roles + guest mode + trusted networks. Operated single-tenant in practice;
tenant plumbing exists but nothing provisions tenant #2.
**History note:** trusted-network bypass caused the 2026-07-01 factory-reset
incident; destructive recovery endpoints now require explicit admin creds.

### F11. Intel feeds (ecosystem awareness)
**Status: ✅ working** — RSS/Reddit/GitHub trending+releases → intel tables +
memory journal; recommendations surface in dashboard Sources.

---

### F13. Browser automation
**Status: ✅ working (profile)** — sessions, numbered-element snapshots, act,
persistent profiles; MUTATE-class actions pause at the consent gate.
**Gap:** F2's missing checkpoint tool blocks end-to-end unattended signups.

### F14. Self-modification (Nova edits its own repo)
**Status: 🟡 gated off** — `SELFMOD_ENABLED=false` default; PAT via platform
secrets; PR-based flow with rate limit; deliberately excluded from the flag
system until per-write confirmation lands (documented decision).

---

## P2 — Nice-to-have

| Feature | Status | Note |
|---|---|---|
| F15. Knowledge crawler | ✅ (profile `knowledge`) | LLM-guided crawl with budget caps; off on audited host |
| F16. Voice (STT/TTS) | ✅ (profile `voice`) | OpenAI-only after 9f031ba cleanup |
| F17. Embedded editors | ✅ (profiles) | code-server + neovim/ttyd in dashboard Editor page |
| F18. Remote access | ⚪ (profiles) | cloudflared / tailscale sidecars, unverified here |
| F19. IDE integration | ✅ | OpenAI-compat proxy at orchestrator `/v1` |
| F20. Friction log | ✅ | with screenshots + "Fix This" task dispatch; auto-friction subscriber |
| F21. AI quality loop | 🟡 | one registered loop; benchmark harness exists (`benchmarks/`) but predates single-backend reality |
| F22. GitHub webhooks + CI triage | ✅ | webhook → stimulus → ci_triage drive → fix-PR pod |
| F23. Marketing site + docs | ✅ | `website/` Astro/Starlight; some service docs missing (cortex, workers) |
| F24. Onboarding wizard (dashboard) | ⚪ | pages exist under `pages/onboarding/`; not exercised in this audit |

---

## Cross-cutting user stories still missing (candidate roadmap items)

1. **"Prove the brain works" first-run experience** — a guided goal that
   completes end-to-end (triage→verify) on a fresh install (bridges F2 gaps).
2. **Memory quality flywheel** — retrieval feedback (`mark_used`, outcome
   scores) actually re-ranking BM25; today the accumulator exists but nothing
   evaluates whether it helps (F1 gap, quality loop unproven).
3. **Human checkpoint** — one approval-with-reply primitive serving both
   browser verification codes and cortex review questions (unblocks F2+F13).
4. **Journal distillation without the brain** — decouple nightly curation from
   the brain toggle (memory-service-side scheduled consolidation, or a
   standing orchestrator cron) so the memory pillar stands alone (F1 gap).
