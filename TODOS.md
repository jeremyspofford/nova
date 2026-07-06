# Nova — Deferred Work

> Items considered and explicitly deferred. Each has enough context to pick up cold.

## Approved roadmap (2026-07-05, post-audit — see `architecture/06-refactor-plan.md`)

Sequenced plan approved by Jeremy 2026-07-05 (also tracked as tasks #1–15 in the session task list):

- **Phase 0 — Truth pass** (half day): `chmod +x scripts/*.sh`, stale "no bundled inference" compose comments, dead `COMPOSE_PROFILES` values (`bridges`, `search`), dead Deepgram/ElevenLabs env vars, CORS 3001→3000, delete `workspace/` junk + `PROMPT.md`, CLAUDE.md corrections, pytest-timeout (signal) in `tests/pytest.ini`.
- **Phase 1 — Make the suite honest** (1–2 days): factory reset clears `schema_migrations` so seed migrations re-run (fixes ~11 failures); gateway fallback skips credential-invalid providers + rotate dead Groq key (~15 failures); rewrite/delete ~12 stale tests + auth-posture verdicts on ~8 endpoints; migration 093 drops the 9 orphan legacy memory tables.
- **Phase 2 — Safe defaults** (2–3 days): `$HOME` mount `:ro` by default, trusted-network bypass → explicit endpoint allowlist, FC-002 hard-fail check.
- **Phase 3 — Consolidation** (1–1.5 weeks, one PR each): intel-worker→orchestrator, chat-api→orchestrator, voice→llm-gateway, screenpipe+knowledge→one `ingest-worker` (12→9 always-on containers).
- **Phase 4 — Nova starts DOING things**: push channel (DECIDED: bundled self-hosted **ntfy** with action-button approve/deny; Telegram as an additional user-selectable channel ~v2) + `request_human_checkpoint` primitive → daily-briefing standing goal → cortex learning-from-failures → journal curation decoupled from the brain toggle → brain on by default with training wheels.
- **Feature tracks (parallel):** memory graph (graph endpoint + missing `PUT /api/v1/memory/items/{id}`; click = OKF frontmatter only, content behind a button, edit/delete from detail view); observability (`observability` compose profile — Grafana Postgres-datasource dashboards first, `/metrics` instrumentation second); **Nova identity** (DECIDED: provider-configurable mailbox via generic IMAP/SMTP abstraction, **Gmail first**; NO Vaultwarden mirror — admin Identity/secrets dashboard page over `capability_credentials` with masked list, audited reveal, add/update, and Forget-vs-Decommission removal; phone number and PWA/native app later; every signup stays consent-gated).

## Priority: Browser account-signup checkpoints (from the 2026-07-02 browser-worker work)

**Status (2026-07-06):** SHIPPED as task #8 milestone B — `request_human_checkpoint(reason, instructions, context?)` tool, `waiting_human` parking with conversation snapshot, `decide_approval().response_text`, approval-worker resume with reply injection, checkpoint-aware ApprovalCard with reply box, 24h reaper sweep, 4 integration tests (`tests/test_human_checkpoint.py`).
**Remaining (task #8 milestone C):** ntfy action buttons → signed approve/deny webhooks (lockscreen decisions without opening the dashboard); screenshot capture/rendering on checkpoint cards; richer waiting_human panel in the task detail sheet.
**Added:** 2026-07-02 · shipped 2026-07-06

## Priority: Cortex Autonomy Gaps

These are the gaps preventing Nova from being truly self-directed. Ordered by impact.

### Maturation Pipeline Executor + Learning from Failures + Cortex Tests (B3)
**Status (corrected 2026-07-05 — see `architecture/05-dead-code.md` §0):** the maturation executor SHIPPED (`cortex/app/cycle.py:610-645` dispatches scoping/speccing/building/verifying; `drives/maintain.py` runs triage) and cortex/maturation/decomposition tests EXIST (15+ files in `tests/`). The only genuinely open piece:
**Learning from failures (3d):** PLAN phase queries `/api/v1/memory/context` for reflection entries — cortex reflections already flow through the OKF ingestion queue into journal/topics, so this is a pure retrieval change.

### Goal Decomposition
**Status (corrected 2026-07-05):** SHIPPED — the building phase spawns child goals / flat `goal_tasks` with a depth wall, covered by 4 `test_decomposition_*` files (currently red only from the Groq-key cascade, not logic — see `architecture/05-dead-code.md` §5·B).
**What:** Break high-level goals ("build a feature") into subtask DAGs instead of one monolithic blob per cycle.
**Why:** Without decomposition, Cortex can only work on one atomic chunk per thinking cycle. Complex goals stall because there's no way to parallelize or sequence sub-work.
**How:** Planning phase in the thinking loop produces a DAG of subtasks with dependencies. Cortex dispatches leaf tasks, tracks completion via TRACK phase, and schedules dependents.
**Effort:** 2-3 weeks
**Added:** 2026-03-27

### Learning from Failures
**What:** Read prior reflections back before planning new cycles.
**Why:** Cortex writes reflections to engrams after each cycle but never queries them. It repeats the same mistakes because it has no memory of what went wrong before.
**How:** In the PLAN phase, query engrams for recent reflections/failures related to the current goal. Include them in the LLM planning prompt.
**Note:** Crash recovery context (2026-03-31) now provides full checkpoint data for failed tasks — the planner sees all completed stage outputs and where it failed. Remaining scope: query engram reflections for broader failure patterns across goals.
**Effort:** 3 days (reduced from 1 week)
**Added:** 2026-03-27

### Cortex Integration Tests
**Status (corrected 2026-07-05):** they exist (`test_cortex_*`, `test_maturation_*`, `test_decomposition_*`, `test_drive_scheduling`). Remaining: fix the two `test_drive_scheduling` tests that fail on `ModuleNotFoundError: app.drives` (import cortex internals not on the tests' pythonpath) and extend TRACK-phase feedback coverage.
**Added:** 2026-03-27 · corrected 2026-07-05

## Friction Log Enhancements

### Docker Log Auto-Attach
**What:** When clicking "Fix This" on a friction entry, auto-capture recent service logs (last 10 min) and include them as context in the pipeline task input.
**Why:** Logs contain the actual error traces that caused the friction. Manual paste is a workaround but adds friction to the friction-reporting process.
**How:** Either mount Docker socket in orchestrator (security concern) or call the recovery service's existing Docker API access to pull logs. Recovery already has socket access.
**Blocked by:** Decision on whether orchestrator should have Docker socket access, or if recovery service should expose a log-retrieval endpoint.
**Added:** 2026-03-19

### Friction-to-Engram Pipeline
**What:** Feed friction log entries into the engram memory system so Nova "remembers" past friction and avoids repeating patterns.
**Why:** Friction entries represent hard-won learnings about what breaks. If the memory system knows "file uploads crash when disk is >90% full," future tasks can be warned.
**How:** On friction entry resolution (status → fixed), push a structured engram to `engram:ingestion:queue` with the friction description, resolution, and any associated task output.
**Blocked by:** Friction log feature must exist first. Engram ingestion must be stable.
**Added:** 2026-03-19

### GitHub Issue Export
**What:** One-click to create a GitHub issue from a friction entry. Pre-populates title, description, severity label.
**Why:** Bridges internal friction tracking to external visibility. Useful for open-source or when inviting external users.
**How:** GitHub API or `gh` CLI from orchestrator. Requires `GITHUB_TOKEN` in .env.
**Blocked by:** Friction log feature must exist first.
**Added:** 2026-03-19

### Screenshot File Cleanup Tooling
**What:** Orphan detection + disk usage monitoring for friction screenshot files.
**Why:** File-based storage can accumulate orphans after DB restores or manual deletes.
**How:** Script or endpoint that compares filesystem to DB, deletes orphaned files, reports disk usage.
**Blocked by:** Friction log with file-based screenshot storage.
**Added:** 2026-03-19

## Cloud LLM Providers

### Activate ChatGPT Subscription Provider
**What:** Run `codex login` to authenticate, then set `CHATGPT_TOKEN_DIR=~/.codex` in `.env`. Nova's `ChatGPTSubscriptionProvider` is already fully built — streaming, tool calls, auto-discovery from `~/.codex/auth.json`. Just needs the auth token.
**Why:** Gets GPT-4o and o3 on subscription (zero API cost) with full tool support. Currently the only working cloud provider with tool calls — Claude subscription OAuth is limited to Haiku 4.5.
**How:** `codex login` → add `CHATGPT_TOKEN_DIR=~/.codex` to `.env` → restart llm-gateway. Models available: `chatgpt/gpt-4o`, `chatgpt/o3`, `chatgpt/o4-mini`.
**Blocked by:** Nothing — codex CLI needs to be installed (`npm i -g @openai/codex`), then one login.
**Added:** 2026-03-19

### Re-test Claude 4.6 Subscription OAuth
**What:** Periodically test whether Anthropic has enabled Sonnet/Opus 4.6 for subscription OAuth on the public messages API.
**Why:** Currently `claude-sonnet-4-6` and `claude-opus-4-6` return `invalid_request_error: "Error"` via OAuth token on `api.anthropic.com/v1/messages`. Only `claude-haiku-4-5-20251001` works. Claude Code uses a different internal API path. When Anthropic fixes this, re-add a Claude subscription provider under `llm-gateway/app/providers/` (the previous `claude_subscription_provider.py` was removed in the 2026-07 cleanup).
**How:** `curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $TOKEN" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'` — if it returns a message instead of "Error", it's fixed.
**Blocked by:** Anthropic API change (external).
**Added:** 2026-03-19

## Design System

### Create DESIGN.md via /design-consultation
**What:** Document the dashboard's implicit design system — palette (stone/teal/amber/emerald), typography, spacing scale, component patterns (cards, badges, activity feeds, toggles), icon library (Lucide), and responsive breakpoints.
**Why:** Every new UI element (delegation cards, pod indicators, tool pickers) makes design decisions without a reference. The system exists implicitly in code but isn't documented, increasing drift risk as more UI is added. The chat pod work adds 3+ new UI elements that need to be consistent.
**How:** Run `/design-consultation` to audit the existing dashboard, extract the implicit system, and produce a DESIGN.md as the project's design source of truth.
**Blocked by:** Nothing — can be done anytime. Recommended before the chat pod dashboard integration (Step 4).
**Added:** 2026-03-19

### Full User Entity Management UI
**What:** Dashboard page showing the user entity with edit/delete per attribute. Visual management of "what Nova knows about me."
**Why:** The correction flow (via chat) handles corrections for the common case, but power users need direct visual management of their identity — inspect, edit, delete individual attributes.
**How:** New dashboard route `/identity`, new memory-service endpoints (`GET /api/v1/user-entities/{id}`, `PATCH /api/v1/user-entities/{id}`, `DELETE /api/v1/user-entities/{id}/attributes/{key}`). Table view of enriched envelope attributes (value, confidence, learned_at, source).
**Blocked by:** User Identity Graph feature (retrieval_pool + user_entities table)
**Depends on:** Multi-user auth (for scoping)
**Effort:** M (human: ~1 week / CC: ~2 hours)
**Priority:** P3
**Added:** 2026-04-02
