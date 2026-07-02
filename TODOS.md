# Nova — Deferred Work

> Items considered and explicitly deferred. Each has enough context to pick up cold.

## Priority: Browser account-signup checkpoints (from the 2026-07-02 browser-worker work)

**What:** Human-in-the-loop resume for CAPTCHAs and email verification during browser-driven account signups.
**Why:** The browser-worker (port 8150) can navigate, fill forms, and submit — but real signups hit CAPTCHAs and email verification links. `browser_submit` is MUTATE so it pauses at the capability consent gate today, but there's no flow to hand Nova a pasted verification code and resume the same browser session.
**How:** Add a `request_human_checkpoint(reason, instructions, screenshot?)` tool that creates a pending `approval_requests` row and parks the task in a `waiting_human` status; extend `decide_approval()` / `ApprovalDecision` with a `response_text` field; have `approval_worker.py` re-enqueue the parked task with the response injected as a tool result. Dashboard `PendingApprovals.tsx` / `ApprovalCard.tsx` get a screenshot + free-text reply box.
**Effort:** 3-4 days.
**Added:** 2026-07-02

## Priority: Cortex Autonomy Gaps

These are the gaps preventing Nova from being truly self-directed. Ordered by impact.

### Maturation Pipeline Executor + Learning from Failures + Cortex Tests (B3)
**Status:** Deferred from the 2026-07-02 OKF/actions work — the memory + browser + cleanup phases shipped first.
**Maturation executor (2-3d):** wire `cortex/app/maturation/{triage,scoping,speccing,building,verifying}.py` into the thinking cycle so goals transition through stages instead of sitting in `triaging`.
**Learning from failures (3d, now easier):** PLAN phase queries `/api/v1/memory/context` for `type: reflection` entries — under the OKF backend, cortex reflections already flow through the ingestion queue into the journal/topics, so this is a pure retrieval change.
**Cortex integration tests (2d):** none exist; any refactor can silently break the loop. See detail entries below.

### Goal Decomposition
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

### Maturation Pipeline Executor
**What:** Execute goal maturation stages (triaging → scoping → speccing → review → building → verifying) via Cortex drive logic.
**Why:** Maturation columns exist in the schema but nothing transitions goals through the stages. Goals sit in "triaging" forever.
**How:** New Cortex drive or sub-drive in the Improve/Serve drives that checks goal maturation status and runs the appropriate pipeline action for each stage.
**Effort:** 2-3 days
**Added:** 2026-03-27

### Cortex Integration Tests
**What:** Integration test coverage for goals, drives, thinking loop, task feedback.
**Why:** Zero test coverage on the autonomous brain. Any refactor could silently break the thinking loop.
**How:** Tests in `tests/` that hit Cortex endpoints, create goals, verify drive selection, confirm task dispatch + TRACK phase feedback.
**Effort:** 2 days
**Added:** 2026-03-27

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
**Why:** Currently `claude-sonnet-4-6` and `claude-opus-4-6` return `invalid_request_error: "Error"` via OAuth token on `api.anthropic.com/v1/messages`. Only `claude-haiku-4-5-20251001` works. Claude Code uses a different internal API path. When Anthropic fixes this, update `_MODEL_MAP` in `claude_subscription_provider.py`.
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
