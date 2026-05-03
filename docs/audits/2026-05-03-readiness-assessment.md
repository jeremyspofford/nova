# Nova Readiness Assessment — 2026-05-03

## Executive summary

The capability platform (M11) has shipped its scaffolding — credential vault,
hash-chained audit log, consent state machine, github_external tools,
webhook self-bootstrap, cortex CI-triage drive, watched-repo polling, and a
57-test suite — but the most consequential seam in the user story is broken:
**when a user approves a MUTATE action in the dashboard, nothing executes the
pending tool**. `decide_approval` flips `approval_requests.status` to
`approved` and stops. The original agent already received `consent_pending`
as a tool result, finished its turn (or hit max_rounds), and the cortex Goal
moved on to verifying. There is no background worker watching for approved
rows, no task-resume path, and no queue. This means acceptance criterion #5
in the v1 spec (§13: "Approve the card. A PR opens against the failing
branch") cannot pass autonomously even on a flawless triage. Beyond that,
several smaller integration holes exist: `register_webhook` bypasses the
consent gate it's supposed to exercise, the `ci_triage_agent` pod's
`allowed_tools` lists two tool names that don't exist (`get_run_details`,
`get_check_runs`), the consent gate's "approve & remember" path hardcodes
`provider_kind="github"` in a FIXME, and the approval router still uses a
hardcoded `DEFAULT_TENANT` everywhere despite the schema being multi-tenant
from day one. The platform is **integrated end-to-end up to the consent
gate** and **disconnected after it**. Calling it "shipped" is honest only if
the user is willing to manually re-run a tool after approving — which
defeats the autonomous-CI-triage user story this slice exists to prove.

## Maturity matrix

| Component | Tier | Evidence |
|---|---|---|
| Quartet pipeline (Context→Task→Guardrail→Review→Decision) | Production-ready | `tests/test_pipeline_mechanics.py` (14 tests) + `test_pipeline_behavior.py` (4 tests, gated on LLM); state machine in `orchestrator/app/pipeline/state_machine.py`; docs and live runtime |
| Task queue + heartbeat + reaper + dead-letter | Production-ready | `orchestrator/app/queue.py`; `tests/test_reaper_stale_fail.py`, `test_crash_recovery.py` |
| Credential vault (encrypted at rest, audit on every op) | Tested | `orchestrator/app/capabilities/credentials.py`; `tests/test_capability_credentials.py` (4 tests); only `BUILTIN` backend implemented (raises `NotImplementedError` for vault/1password/bitwarden — see `credentials.py:220`) |
| Capability audit log (hash-chained, append-only) | Tested | `orchestrator/app/capabilities/audit.py`; `tests/test_capability_audit.py` (3 tests) + `test_capability_audit_query.py` (5); hash-chain verify_chain() exists |
| Consent gate (READ/PROPOSE auto, MUTATE pends) | Integrated up to creating pending row | `orchestrator/app/capabilities/consent.py`; `tests/test_capability_consent.py` (11 tests, all stop at "row is approved" — none verify execution) |
| **Approve-then-execute loop** | **Designed only** | No code path resumes execution after `decide_approval`. See finding G1 below. |
| github_external tools (READ/PROPOSE/MUTATE/SETUP) | Tested | `orchestrator/app/tools/github_external_tools.py` (12 tools); `tests/test_github_external_tools.py`, `test_capability_smoke_real_github.py` (5 opt-in real-GitHub tests) |
| Agent runner ↔ capability platform wiring | Tested | `tests/test_runner_capability_wiring.py` (3 tests) — fixed in commit `46623465` |
| Cortex CI-triage drive (stimulus → goal) | Tested | `cortex/app/drives/ci_triage.py`; `tests/test_capability_cortex_wiring.py` (7 tests) — webhook → stimulus → goal verified end-to-end |
| Cortex maturation phases (scoping/speccing/building/verifying) | Tested | `cortex/app/maturation/*.py`; `tests/test_maturation_*.py` (5 files); `review_policy='auto'` honored via `speccing.py:25` |
| Pod hint propagation (goal.current_plan.pod → task) | Tested | `cortex/app/maturation/building.py:184-188`; fixed in commit `28011359` |
| GitHub webhook receiver (HMAC-validated, dispatches stimulus) | Integrated | `orchestrator/app/webhooks_router.py`; `tests/test_capability_webhooks.py` (5 tests) + `test_capability_cortex_wiring.py` |
| GitHub webhook self-bootstrap (register/verify/unregister) | Integrated, but bypasses consent gate | `orchestrator/app/webhooks_router.py:36-72` calls `_register_webhook` directly. See finding G2. |
| Singleton-elected GitHub polling worker | Coded + tested | `orchestrator/app/polling_worker.py`; `tests/test_polling_worker.py` |
| Stimulus→cortex→goal end-to-end (with brain enabled) | Tested (with `CORTEX_TEST_MODE=true`) | `tests/test_capability_cortex_wiring.py::test_e2e_triage_bug_in_pr_dispatches_goal` |
| Real-GitHub smoke suite (opt-in) | Designed + tested when `REQUIRES_GITHUB=1` | `tests/test_capability_smoke_real_github.py` — bypasses Nova webhook receiver (skips full E2E) |
| Engram ingestion + spreading activation | Production-ready | `memory-service/app/engram/`; `tests/test_consolidation.py`, `test_memory_quality.py` |
| Engram consolidation 6-phase loop | Tested | `memory-service/app/engram/consolidation.py`; `tests/test_consolidation.py` (8 tests) |
| Source provenance (sources, dedup, content storage) | Tested | `memory-service/app/engram/sources.py`; `tests/test_sources.py` |
| Memory tools (search_memory/recall_topic/etc.) | Tested | `tests/test_memory_tools.py` (3 tests) |
| Cortex serve + maintain + improve + learn drives | Tested | `cortex/app/drives/`; `tests/test_drive_scheduling.py`, `test_cortex_loop.py` |
| Cortex `quality` drive (AI quality regression — different from CI quality) | Coded | `cortex/app/drives/quality.py:99-117` `react()` is a stub: "full handler integration is deferred until the cycle's react protocol is finalized" |
| Cortex `ci_triage` drive | Tested | covered above |
| Goal maturation lifecycle (decomposition + retry + escalation) | Tested | `tests/test_decomposition_*.py` (4 files) + `test_maturation_*.py` (5 files); 67 migrations |
| LLM gateway multi-provider routing | Production-ready | `tests/test_llm_gateway.py`, `test_inference_backends.py`, `test_inference_modes.py`, `test_model_discovery.py` |
| Auth (JWT + admin secret + API keys + Google OAuth) | Tested | `tests/test_oauth_flow.py`, `test_admin_auth_hardening.py`, `test_auth_isolation.py`, `test_user_identity.py` |
| Trusted-network bypass | Tested | `tests/test_trusted_networks.py` |
| Multi-tenant data isolation | Tested at DB level | `tests/test_fc001_tenant_isolation.py`; routers all hardcode `DEFAULT_TENANT` so the multi-tenant surface is *schema-only*, not request-routed |
| Recovery service (backup/restore/factory reset) | Tested | `tests/test_recovery.py` |
| Knowledge worker (LLM-guided crawl) | Coded | `tests/test_knowledge.py` covers `/knowledge/sources`, `/crawl-log` endpoints; no end-to-end crawl assertion |
| Intel worker (RSS/Reddit/page change) | Coded + tested | `tests/test_intel.py`, `test_intel_recommendations.py` |
| Voice service | Coded | `tests/test_voice.py` |
| Chat-bridge (Telegram/Slack) | Coded | `tests/test_chat_bridge.py` (3 tests, mostly health/status); skips when bridge profile not active |
| Dashboard Connected Services panel | Coded | `dashboard/src/pages/settings/ConnectedServicesSection.tsx` (827 LOC); no UI integration tests |
| Dashboard Pending Approvals panel | Coded | `dashboard/src/pages/PendingApprovals.tsx` (50 LOC); ApprovalCard component handles approve/reject/remember |
| Dashboard Audit Log panel | Coded | `dashboard/src/pages/AuditLog.tsx` (480 LOC) |
| Dashboard Auto-Approve Rules panel | Coded | `dashboard/src/pages/settings/AutoApproveRulesSection.tsx` |
| Cortex `verify_chain` validator (nightly job) | Designed only | `verify_chain()` exists in `audit.py:123` but no caller wires it into `cortex/app/drives/maintain.py` |
| Webhook health monitoring (cortex `maintain` daily ping) | Designed only | Spec §9.1 calls for daily pinging; no code in `cortex/app/drives/maintain.py` does this |

## Integration gaps — high confidence

### G1. Approval → re-execution gap (the worst gap)

**Location:** `orchestrator/app/capabilities/router.py:127-147` (decide_approval) and
`orchestrator/app/capabilities/executor.py:54-77` (execute_tool returns
`consent_pending` and stops). Search confirms there is no consumer of approved
rows: `grep -rn "approved.*execute\|requeue.*approval" orchestrator/ cortex/`
returns nothing.

**Symptom (the production-shape scenario that fails):**
1. CI fails on a watched repo. Webhook → cortex stimulus → ci_triage_agent
   pod is dispatched as a Quartet task.
2. Task agent calls `open_fix_pr(...)`. Tool dispatcher routes through
   capabilities.executor; consent gate creates an approval_request row;
   tool returns `{"status":"consent_pending","approval_id":"..."}` to the
   agent.
3. Agent sees this string in its tool-result message. With no further
   instruction, the agent likely either tries another tool (e.g.
   `comment_on_pr`) or completes its turn.
4. Task finishes; cortex `verifying` runs against the repo and concludes
   the goal is incomplete (no PR exists). Goal loops or escalates.
5. User opens dashboard, sees the pending approval, clicks **Approve**.
6. `decide_approval` updates `approval_requests.status='approved'`. **No
   subsequent action takes place.** The PR is never opened. The audit log
   shows `consent_request` (pending) but no follow-up `tool_call` for
   `open_fix_pr`.

**Severity: Critical.** This breaks the v1 acceptance criterion #5 ("Approve
the card. A PR opens"). Manual workaround: the user would have to manually
re-trigger the tool — which defeats autonomy.

**Fix shape:** When `decide_approval` flips status to `approved`, enqueue a
follow-up "execute_approved" task (or push a redis message a worker
consumes). The worker re-runs the underlying tool with the original args
(stored in `args_redacted`), then writes the resulting `tool_call` audit row
with `task_id` from the original approval. The agent thread doesn't need
to be resumed — the action just needs to *happen*.

---

### G2. `register_webhook` bypasses the consent gate it's classified for

**Location:** `orchestrator/app/webhooks_router.py:36-72` calls
`_register_webhook(...)` directly, supplying an admin-resolved secret —
never going through `capabilities.executor.execute_tool` despite the tool
being classified `BlastRadius.MUTATE` in
`github_external_tools.py:215-220`.

**Confirmed by:** `docs/capability-acceptance-checklist.md:43-49` explicitly
notes:
> "Spec deviation in v1: the spec says webhook registration goes through
> the consent gate and surfaces a register_webhook MUTATE approval card.
> v1 implementation uses the admin-direct path instead (no approval
> card). The webhook itself is still created on GitHub and verified
> end-to-end."

**Symptom:** No approval card appears for first watched-repo addition.
Spec §9.1 promised that the first add exercises the consent gate (and even
auto-creates an "approve and remember" rule for that repo's later
re-bootstraps). Since this never fires, the auto-rule path (§9.1
"Auto re-bootstrap consent") is also unreachable in practice.

**Severity: High.** Misses one of the key end-to-end demonstrations of the
consent platform — and is a security regression vs. the spec, since the
admin-secret path is gated only by the X-Admin-Secret header (no per-action
audit context tied to a task_id).

---

### G3. `ci_triage_agent` pod has phantom tool names in `allowed_tools`

**Location:**
`orchestrator/app/migrations/073_ci_triage_agent_pod.sql:30-31` (Task Agent row)
specifies tools `get_run_details` and `get_check_runs` in `allowed_tools`,
but neither tool is registered: actual tool names per
`orchestrator/app/tools/github_external_tools.py:30-253` are
`list_workflow_runs`, `get_workflow_run`, `get_run_logs`, `get_run_diff`,
`compare_to_main`, `diagnose_failure`, `draft_fix`, `open_fix_pr`,
`comment_on_pr`, `register_webhook`, `unregister_webhook`, `verify_webhook`.

**Symptom:** When the Task Agent calls `get_run_details(...)` or
`get_check_runs(...)`, dispatch returns `"Unknown tool 'get_run_details'.
Available: [...]"` (per `orchestrator/app/tools/__init__.py:191-192`). The
agent has to recover with a different tool. Mostly cosmetic — but in
practice this means the system prompt's mention of "fetching workflow
details" maps to a tool that doesn't exist; the agent often fumbles the
first turn.

**Severity: Medium.** Easy fix (rename in migration, or add a 077 migration
that updates the pod_agents row).

---

### G4. Approve-and-remember rule creation hardcodes `provider_kind="github"`

**Location:** `orchestrator/app/capabilities/consent.py:204-209` —
`decide_approval` inserts a `consent_rules` row with
`provider_kind = "github"` and a `# FIXME: derive from approval row context`
comment. The provider_kind is not stored on `approval_requests` (per the
schema in `orchestrator/app/migrations/070_consent_and_approvals.sql`), so
this can't be derived without a separate lookup.

**Symptom:** A user approves-and-remembers a Cloudflare or AWS or Slack
MUTATE call (in v2+) and accidentally creates a `consent_rules` row that
matches GitHub tool calls instead. v1 only ships GitHub so this is dormant —
but it's a load-bearing FIXME that the M12 work will hit immediately.

**Severity: Medium-low (today), High (when the second provider lands).** Fix:
add a `provider_kind` column to `approval_requests` in a new migration,
populate it on insert from `consent.gate(... provider_kind=...)`, and read
it in `decide_approval`.

---

### G5. Approval-card hardcoded `DEFAULT_USER` in same path

**Location:** `orchestrator/app/capabilities/consent.py:18, 206` — uses
module-level `_DEFAULT_USER = UUID("00000000-0000-0000-0000-000000000001")`
regardless of who actually approved the action. The approval row records
`decided_by` from the request payload, but the resulting `consent_rules.user_id`
is always the synthetic admin.

**Symptom:** Multi-tenant SaaS will mis-attribute consent rules to a fake
user. Every consent rule belongs to "admin" rather than the human reviewer.

**Severity: Medium-low (today), Critical (multi-tenant SaaS).**

---

### G6. Capability router-wide `DEFAULT_TENANT` bypass of multi-tenancy

**Location:** `orchestrator/app/capabilities/router.py:35-36, 55, 69, 80,
93, 105, 115, 137, 142, 165, 189, 213, 244-247, 267, 283, 295, 311, 346,
368`. Every capabilities endpoint hardcodes
`DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")` and
`DEFAULT_USER` instead of resolving from auth context. The DB schema is
multi-tenant from migration 068 onward, but the API surface ignores the
caller's identity.

**Symptom:** A multi-user instance — even one where two human users share
the admin secret — leaks every credential, approval, and audit row to all
users. There is no isolation at the request boundary.

**Severity: Critical (for multi-user / SaaS).** v1 single-user-on-localhost
is OK; the moment there's a second authenticated user (or an inside-the-
tailnet deploy with multiple humans), the platform discloses everyone's
state. Per memory: Nova "is a product shipping to real users — self-hosted
or SaaS" — this gates the "real users" claim.

---

### G7. `_build_tool_context_for_task` also hardcodes `DEFAULT_TENANT`

**Location:** `orchestrator/app/pipeline/executor.py:1262-1300`. Same
hardcoded UUID is propagated into the tool_context for every credentialed
tool call, regardless of which user/tenant owns the goal/task.

**Severity: Critical for multi-tenant.** Same root cause as G6.

---

### G8. Webhook-receiver does not gate on which tenant owns the matching hook

**Location:** `orchestrator/app/webhooks_router.py:126-154`. The receiver
fetches **all** github_webhooks rows in active/verified/pending states and
loops through them trying to match HMAC. It successfully cross-tenant-
matches: a webhook fired for tenant A's repo can validate against tenant
B's secret if tenants A and B have the same secret bytes (astronomically
unlikely for AES-256-GCM-encrypted secrets, but not enforced — and the
fetch is `O(n_webhooks)` per request, which becomes a DoS vector at scale).

**Severity: Low (today), Medium (multi-tenant).** Add a deliveries index by
hook_id from the GitHub-supplied `X-GitHub-Hook-ID` header, then validate
against just that row's secret.

---

### G9. Cortex `quality` drive is a stub, not the CI-triage drive

**Location:** `cortex/app/drives/quality.py:99-117`. The drive's `react()`
is documented as a stub: "full handler integration is deferred until the
cycle's react protocol is finalized for new drives. For now, the drive just
signals via proposed_action and the human (or future cycle integration)
acts."

This is **a different drive** from `ci_triage` — `quality` watches AI
quality regressions, not CI failures. But the spec §3 says the CI triage
slice is "cortex's existing quality drive autonomously triages failed CI
runs end-to-end." The actual implementation uses a separate
`ci_triage` drive with no integration into the `quality` drive's
"trigger retrieval_tuning" path. This is OK functionally — but it means
the only AI-quality-monitoring drive Nova ships is a no-op.

**Severity: Low (cosmetic for capability platform), but an unfulfilled
promise from `roadmap.md` and `quality_loop` infrastructure that was built).**

---

### G10. `verify_chain` audit-tamper detection is unwired

**Location:** `orchestrator/app/capabilities/audit.py:123-170` exposes
`verify_chain()`. No caller in the codebase invokes it. Spec §8.2 promised
"Nightly maintain drive job re-walks each tenant's chain; any break is
reported as a security event." Search across `cortex/app/drives/`,
`maintain.py`, scheduler.py, and orchestrator: no scheduler hook.

**Symptom:** A compromised app can in theory be detected by re-walking the
chain, but no automation does so. Nothing alerts on tamper.

**Severity: Medium.** Critical for compliance/security claims; low for
day-to-day usefulness today.

---

### G11. Webhook health monitoring (cortex daily ping) is unwired

**Location:** Per spec §9.1 "Webhook health monitoring: cortex maintain
drive runs daily, pinging each github_webhooks row's hook_id." Search
`cortex/app/drives/maintain.py` and grep for `hook_id|github_webhooks` in
cortex: no implementation. Auto-rebootstrap on failure (§9.1) is also
unwired.

**Symptom:** A webhook that GitHub silently drops (account perms changed,
GitHub re-issued the hook ID, hook_id revoked) won't be detected; cortex
thinks it's still receiving events and the polling fallback will catch
some failures but not all. No dashboard alert.

**Severity: Medium.** The polling-only fallback path covers most cases
(triage still fires within 15 min), but the "verified webhook degraded
silently" path is undetectable without this.

---

### G12. Stimulus shape mismatch between webhook receiver and polling worker

**Location:** `orchestrator/app/webhooks_router.py:175-188` emits a stimulus
with `payload: {tenant_id, repo, run_id, ...}` (nested), while
`orchestrator/app/polling_worker.py:165-176` emits `{type, tenant_id, repo,
run_id, ...}` (flat — no `payload` wrapper). Both are consumed by
`cortex/app/drives/ci_triage.py:141-145` which defensively reads
`stimulus.get("payload") or stimulus`.

**Symptom:** Both shapes work today because the consumer is defensive. But
this is fragile: if a third producer is added (e.g. a chat command that
manually triggers triage), it must remember to emit one of the two
shapes — or extend the OR chain. Better: standardize the shape now.

**Severity: Low.** Fragile rather than broken.

---

### G13. ci_triage drive uses non-atomic INSERT-then-UPDATE for goals.current_plan

**Location:** `cortex/app/drives/ci_triage.py:253-288`. After
`POST /api/v1/goals` returns a goal row, the drive runs a separate
`UPDATE goals SET current_plan = $1::jsonb WHERE id = $2::uuid` to write
the CI metadata. If the orchestrator restarts between the POST and the
UPDATE, the goal lands in the queue **without** `ci_run_id`,
`ci_watched_repo_id`, or `pod=ci_triage_agent`. The next stimulus for the
same run_id won't deduplicate (because dedup checks `current_plan->>
'ci_run_id'`), and the goal will dispatch to the default Quartet pod
without credentialed tools.

**Severity: Low (rare in practice), Medium for production.** Fix: add
`current_plan` (or `metadata`) to `POST /api/v1/goals` request body so
it's set atomically with the INSERT.

---

### G14. The `task_summary` engine for tasks built from cortex goals is missing the audit-log link

**Location:** `dashboard/src/pages/Tasks.tsx` — task detail page links to
audit log via `audit-log?task_id=...`. But `task_id` for cortex-spawned
tasks is filtered by `tasks.metadata.source = 'cortex.building'` and the
audit log filter uses `task_id` directly. If a cortex goal launches three
tasks (one per child), the audit log filter only shows the audit rows
linked to a single one. There's no "audit for this goal" filter that
joins by `goal_id`.

**Severity: Low.** Cosmetic; could surprise a user investigating why a
goal didn't open a PR.

---

## Production-readiness blockers

### P1. CREDENTIAL_MASTER_KEY can be empty on first run

**Where:** `orchestrator/app/config.py:118` — `credential_master_key: str = ""`.
`scripts/install.sh:142-145` generates one only if the user is running the
install wizard. A user who clones the repo and runs `make up` directly
gets an empty value; the first POST to
`/api/v1/capabilities/credentials` raises HTTPException 500
("CREDENTIAL_MASTER_KEY not configured") per
`credentials.py:42-46`. The dashboard shows a generic error.

**Severity:** High. Day-1 users without the install wizard hit this. Either
auto-generate at orchestrator startup (and persist to platform_config) or
fail the orchestrator startup loudly with a clear message.

---

### P2. Encryption-key rotation is undefined

**Where:** `capability_credentials.key_version INTEGER NOT NULL DEFAULT 1`
exists per migration 068, and
`nova_worker_common/credentials/builtin.py` derives a tenant subkey via
HKDF. But no code path increments `key_version` or re-encrypts existing
rows on rotation. `_provider()` in `credentials.py:37-47` is a module-level
singleton instantiated once on first use; restart picks up key changes —
silently breaking decryption of existing rows.

**Severity:** Critical for production / SaaS. A user who rotates the master
key permanently loses access to their stored credentials with no error
until the first decrypt attempt.

**Fix:** explicit migration helper that decrypts with old key and re-
encrypts with new, bumping `key_version`. Wire to a `/admin/rotate-keys`
endpoint or a CLI command.

---

### P3. Approve-and-remember produces an unsafe-by-default rule

**Where:** `dashboard/src/components/ApprovalCard.tsx:148-153` lets users
type a `target_glob` (defaults to `*`) and clicks "Approve and save rule."
A click with the default `*` produces a rule that auto-approves *every
future* call to the same `tool_name` regardless of repo. The dashboard
explains this in tiny help text — but the default value is the most
permissive option.

**Severity:** Medium. A user clicking through quickly opens themselves to
auto-PR-creation across all watched repos.

**Fix:** Default to the *currently-targeted* repo glob (e.g.
`repos/<owner>/<name>/*`) inferred from `args_redacted.repo`. Require an
explicit override to widen.

---

### P4. CI triage daily budget cap UI is hidden behind admin secret

**Where:** Setting daily budget requires editing `cortex_watched_repos.daily_budget`
via the dashboard's `WatchedRepoEditModal`. The default is 20, which is
high for a brand-new user. A flaky CI on a new watched repo can produce
dozens of triage attempts before the user notices.

**Severity:** Medium. Default budget should be lower (5?) or onboarding
should ask.

---

### P5. Webhook bootstrap requires admin-direct path; user gets no consent UX

**Where:** Per G2 above. From the user's perspective, the workflow is
"Add credential → click 'Watch a repo' → click 'Webhook' button → modal
asks for public URL → click 'Register'." The modal does not preview what
GitHub will be told, what scopes are required, or that the secret is
generated client-side. Errors from GitHub (e.g., scope missing) surface
as a 422 from the orchestrator with raw JSON.

**Severity:** Medium. Onboarding clarity.

---

### P6. Smoke suite documents flow but doesn't exercise webhook → triage E2E

**Where:** `tests/test_capability_smoke_real_github.py` (5 tests, opt-in)
covers credential validation, list runs, webhook lifecycle (register → ping
→ unregister via direct API), open/close PR, comment. But the flow that
matters most — "GitHub fires webhook to Nova → Nova runs triage → Nova
opens PR" — is gated as a *manual* walkthrough in
`docs/capability-acceptance-checklist.md`. There's no automated proof that
the full flow works against real GitHub.

**Severity:** High. The user has a manual checklist that requires their
public URL be exposed. They cannot run this in CI. Until they actually do
the walkthrough end-to-end, "M11 shipped" is partially aspirational.

---

### P7. PAT scopes warning is data-only — no UX gate

**Where:** `orchestrator/app/capabilities/credentials.py:330-336` captures
GitHub's `X-OAuth-Scopes` header into `credentials.scopes.granted`. But
nothing surfaces a warning if `admin:repo_hook` is missing — the dashboard
just shows the green dot. A user adding a PAT with only `repo` scope finds
out the webhook can't be created only after they click Register, then
get a 422.

**Severity:** Low-Medium. Friction but not blocking.

---

### P8. Knowledge worker, voice service, chat-bridge are profiles — no day-1 sanity check

**Where:** `make up` doesn't include `--profile knowledge bridges voice`.
Users discover these services only by reading docs. Each has its own
required env (Telegram bot token, Slack OAuth, Whisper key, etc.).

**Severity:** Low. Documented; users opt in.

---

## Test coverage gaps

The areas below have no integration tests at the seam where reality lives:

1. **Approve → execute loop** — no test verifies that approving a pending
   approval ever causes the underlying tool to run. Test stops at row.status.
   (Because no code path implements it — see G1.)

2. **`register_webhook` consent flow** — no test verifies the consent
   gate fires for first webhook registration. Tests drive directly through
   `_register_webhook` or the admin endpoint, both of which bypass the gate.

3. **Cortex `verify_chain` integrity sweep** — `tests/test_capability_audit.py`
   tests the function in isolation. No test verifies it's invoked by any
   scheduler or drive. (Because no caller exists.)

4. **Webhook degradation detection** — no test verifies that a stale/revoked
   webhook gets re-bootstrapped or surfaces a dashboard alert. (Because no
   code does the daily ping.)

5. **End-to-end: webhook → PR opened on real GitHub** — only the manual
   checklist exercises this. No CI gate, no nightly smoke pass.

6. **Multi-user isolation in capabilities/** — `test_fc001_tenant_isolation.py`
   tests the orchestrator's general tenant_id propagation. The capabilities
   router never reads tenant_id from auth context, so isolation can't be
   tested at that boundary — it's hardcoded.

7. **Encryption key rotation** — no test exercises rotating
   `CREDENTIAL_MASTER_KEY` and verifying old credentials still decrypt
   (because nothing implements rotation).

8. **Cortex `quality` drive react()** — the existing test in
   `test_cortex_loop.py` checks the drive runs without crashing, but the
   `react()` path is a stub. No test asserts retrieval_tuning gets
   triggered when memory_relevance regresses.

9. **The full ci_triage_agent agent loop** — no test exercises the LLM
   loop calling `compare_to_main → diagnose_failure → draft_fix → open_fix_pr`
   end-to-end (the smoke tests bypass the LLM, the unit tests stub the
   LLM call). The agent's prompt could regress without detection.

10. **JSONB asyncpg codec consistency** — the recent fix in `ea5dae38`
    establishes "asyncpg codec runs json.dumps; don't double-encode."
    But other modules still call `json.dumps(...)` before passing JSONB:
    `cortex/app/maturation/verifying.py:167` (`goal_verifications` insert),
    `cortex/app/drives/ci_triage.py:285-287` correctly passes a dict.
    The verifying path looks right because it uses `$3::jsonb` casting
    text. But this is a footgun — a mixed convention across the codebase.

11. **Heartbeat on long-running triage tasks** — the agent runner heartbeats
    every 30s; the reaper kills tasks idle for 150s. A `git clone --depth
    10` of a 500MB repo on a slow link could exceed 150s without progress
    if the LLM is also slow. No test exercises a multi-minute tool call.

12. **MCP server credential injection** — spec §6.4 promises HTTP MCP gets
    per-call header injection from the vault. No code path implements
    this, and no test exercises it. (This is M12 territory and known.)

## Roadmap to "production-ready v1"

Ordered by criticality. S/M/L = small/medium/large complexity.

### Tier 1 — Unblock the user story (must ship for v1 to claim "shipped")

1. **Approve → execute worker** *(L)*
   Why: G1, the worst gap. Without this, no autonomous PR ever gets opened.
   Acceptance: A user pushes a breaking commit, Nova fires the approval card,
   user clicks Approve, **without manual intervention** the PR opens within
   60s. The audit chain shows `consent_request → approve → tool_call(success)`
   with the same `task_id`. Test: `tests/test_capability_approve_execute.py`
   covering happy path + reject + timeout.

2. **`register_webhook` through consent gate** *(M)*
   Why: G2. The first MUTATE the user encounters as part of onboarding
   should be the demo of the consent platform.
   Acceptance: Adding a watched repo with "Webhook + polling fallback"
   surfaces an inline consent card; approve creates the hook and stores the
   row. Auto-rule for re-bootstraps is created. No admin-direct path.

3. **CI triage end-to-end automated test** *(M)*
   Why: P6. We need a CI-runnable proof, not a manual checklist.
   Acceptance: With `REQUIRES_GITHUB=1` set, a smoke test pushes a real
   breaking commit to `nova-test-cap`, polls for a Nova-opened PR within
   5 min, asserts the PR is opened with the fix, closes the PR.

4. **CREDENTIAL_MASTER_KEY auto-bootstrap** *(S)*
   Why: P1. Day-1 friction.
   Acceptance: Orchestrator starts cleanly with empty
   `CREDENTIAL_MASTER_KEY` — generates one, persists to `platform_config`
   (or .env), logs a one-line warning. Subsequent restart loads from store.

### Tier 2 — Multi-user / second provider readiness

5. **Resolve auth → tenant_id in capabilities router** *(M)*
   Why: G6, G7. Schema is multi-tenant from day one; routing is not.
   Acceptance: All capability endpoints derive tenant_id from
   the authenticated user's row; tests prove user A cannot read user B's
   credentials, approvals, or audit rows.

6. **`provider_kind` column on approval_requests** *(S)*
   Why: G4. Removes the FIXME blocking M12.
   Acceptance: New migration adds the column; consent.gate writes it;
   decide_approval reads it for consent_rules insert.

7. **Drive verify_chain into cortex maintain drive** *(S)*
   Why: G10. Surface tampering so the security claim isn't aspirational.
   Acceptance: Daily cortex maintain run calls verify_chain per tenant;
   on broken link, emits a `security.audit_chain_broken` stimulus and logs
   ERROR with broken_at id.

8. **Cortex daily webhook health ping** *(S)*
   Why: G11. Auto-detect silent webhook degradation.
   Acceptance: Daily run pings each github_webhooks row's hook_id via
   GitHub API; on failure, status='failed' and dashboard alert.

### Tier 3 — Robustness + polish

9. **Encryption key rotation path** *(M)*
   Why: P2. Compliance/security claim requires this.
   Acceptance: `POST /api/v1/capabilities/credentials/rotate-master-key`
   with old + new keys re-encrypts all rows, increments `key_version`,
   audits.

10. **Sane defaults for approve-and-remember** *(S)*
    Why: P3. Default scope should be the current target, not `*`.

11. **Default daily_budget=5 + onboarding nudge** *(S)*
    Why: P4. Lower default; onboarding asks.

12. **Atomic goal+current_plan creation** *(S)*
    Why: G13. POST /api/v1/goals accepts `current_plan` so cortex doesn't
    have to do INSERT then UPDATE.

13. **Standardize stimulus payload shape** *(S)*
    Why: G12. Both polling and webhook emit the same nested
    `{type, payload: {...}}` shape; consumer drops the OR chain.

14. **PAT scope-warning UX** *(S)*
    Why: P7. Surface missing scope warnings before the user tries to
    register a webhook.

15. **Fix `ci_triage_agent` allowed_tools list** *(S)*
    Why: G3. Migration 077 corrects the names.

16. **Webhook receiver indexed by hook_id, not full scan** *(S)*
    Why: G8. Use `X-GitHub-Hook-ID` header for O(1) lookup.

### Tier 4 — Future provider work (M12+)

17. **MCP credential injection** — covered by spec §6.4; deferred.
18. **Cloudflare provider via MCP** — spec §11.
19. **AWS provider hybrid (native MUTATE + MCP READ)** — spec §11.
20. **Auto-approve rule proposal from outcome feedback** — spec §9.5,
    Tier E from the brainstorm.

## Things to NOT do

- **Don't add more `test_capability_*.py` unit tests** until G1 is closed.
  The existing 57 tests prove the consent gate and audit log work in
  isolation — adding more would just deepen the false sense of "shipped."

- **Don't refactor `_DEFAULT_TENANT` / `_DEFAULT_USER` constants individually.**
  Solve G6 once with a proper auth → tenant_id resolver dependency in
  FastAPI; replace all hardcodes in one PR.

- **Don't build a second provider (Cloudflare / AWS) before fixing G1, G2,
  G6.** The whole point of building github_external first was to prove the
  platform end-to-end. Adding a provider before approve→execute works
  multiplies the broken seams.

- **Don't remove the polling worker** even after webhook flows are solid.
  It's the always-on fallback per spec §9.1; removing it breaks
  self-hosted users without public ingress (per memory: that's a primary
  user persona).

- **Don't extract `capability-broker` to a microservice.** Spec §4 calls
  this out: "Can be extracted later if growth demands it." Today's gaps
  are integration seams within the orchestrator — extracting them to a
  new service would multiply the seams, not fix them.

- **Don't add chat-bridge auto-approve via Telegram/Slack.** Spec §12 calls
  this v1.5+. The decision API is approver-agnostic but no UX exists.
  Adding it before the dashboard approval flow actually works (G1) is
  premature.

- **Don't normalize the `knowledge_credentials` table to match
  `capability_credentials` (`provider` → `backend`).** Spec §6.1
  intentionally defers this. The schema divergence is documented.

- **Don't add fancy structured concurrency / actor-model rewrites of the
  cortex cycle**. Drive scheduling works (per `test_drive_scheduling.py`);
  the integration gap is between cortex outputs and orchestrator inputs,
  not within cortex.
