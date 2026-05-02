# Nova Capability Platform — Design Spec

**Date:** 2026-05-01
**Status:** Draft (post-brainstorm, pre-implementation plan)
**Author:** Jeremy Spofford + Claude Code
**Tracks:** Roadmap autonomy levels 4 (Triggered execution) and 6 (Self-directed)

---

## 1. Problem statement

Nova has the **brain**: cortex (autonomous goals/drives/maturation), the Quartet pipeline (5-stage safety-railed execution), engram memory, the LLM gateway, and an internal tool registry. What Nova lacks is **credentialed hands** for the outside world.

Today's tools are inward-facing — `Code`, `Git`, `Web`, `Diagnosis`, `Memory`, `Intel`, `Config`, and a `GitHub` group explicitly labeled *Self-Modification* that only manages PRs against Nova's own repo. To let Nova *do things* — manage Cloudflare DNS, troubleshoot failed GitHub Actions on arbitrary repos, write and deploy applications, operate AWS/Azure/GCP resources — we need a platform that handles credentials, consent, blast-radius classification, and audit for *any* third-party system, native or via MCP.

This spec defines that platform and proves it on a single first slice: **failed GitHub Actions triage**.

## 2. Goals and non-goals

### Goals

- One credential vault that serves both native tools and MCP servers, multi-tenant from day one.
- Universal consent gate that sits between agent tool-call decisions and tool execution. Every external action — native or MCP — flows through it.
- Tiered blast-radius model (READ / PROPOSE / MUTATE / DESTRUCT) that scales policy with risk.
- Tamper-evident audit log per tenant.
- Cortex's existing `quality` drive autonomously triages failed CI runs end-to-end on watched repos.
- All v1 mutations are reversible; consent is required for every one.

### Non-goals (this slice)

- No DESTRUCT-tier tools in v1 (no force-push, no branch-delete, no resource-deletion).
- No browser automation / per-task containerized workspace (deferred to archetype D).
- No Cloudflare, AWS, Azure, or GCP providers in v1 — schema and abstractions support them, but only GitHub ships first.
- No multi-user UX in v1 — designed multi-tenant, runs single-tenant for Jeremy.
- No tier E (auto-approve rules) authored by humans in v1 — cortex *proposes* rules from outcome data; users accept/reject; manual rule authoring deferred.

## 3. First-slice scope: Failed GitHub Actions triage

**The user story:** A push to a watched GitHub repo triggers Actions; one or more jobs fail; cortex's `quality` drive notices, dispatches a triage task; Nova reads the failing run's logs, identifies whether the bug is in the PR or on main, drafts a minimal fix, requests consent to open a PR, executes if approved.

**Why this slice first:**

1. Read-heavy with optional mutation — exercises every platform piece without touching destructive actions.
2. Forces the entire spine: vault, consent, audit, blast-radius, MCP-vs-native abstraction, cortex integration.
3. Reasoning-rich (parsing logs, locating bugs, drafting patches) — distinguishes "agent" from "script."
4. High personal-leverage value for Jeremy *and* a clean demo for the SaaS pitch later.
5. Compounds: once GitHub API is credentialed and platform-gated, "create repo," "comment on issue," "review PRs" become tiny extensions; Cloudflare/AWS slot in as new providers.

**Autonomy ceiling for v1:** Tier C — Diagnose + open a follow-up PR. Mutations go through PR review (Jeremy's existing safety net). Path to tier E (auto-approve rules) is data-driven via cortex outcome feedback, not human-authored policy.

## 4. Architectural approach

**Hybrid: native provider modules + MCP servers, both behind one platform.**

| Layer | Implementation | Rationale |
|---|---|---|
| Platform spine (vault, consent, audit, blast-radius classifier, executor) | Native Python in `orchestrator/app/` | Unique-to-Nova safety machinery. Owned and tested. |
| GitHub provider (v1) | Native: `orchestrator/app/tools/github_external_tools.py` | High-frequency, custom reasoning needed (branching heuristic, dry-run modes), security-sensitive |
| Cloudflare provider (future) | MCP (official server) | Solid official MCP exists. Wrap in spine. |
| AWS provider (future) | Hybrid: native for destructive 5%, MCP for read-heavy 95% | Surface too vast for full native. Blast-radius nuance needs native control on mutations. |
| Azure / GCP / GitLab / Slack / Linear (future) | MCP-first | Add as MCP servers register; spine handles them uniformly. |

The spine treats native modules and MCP servers as two flavors of the same abstract `Provider`. The existing `pipeline/tools/registry.py` already merges static and dynamic tools for LLM requests — we extend it with blast-radius metadata and route every call through the consent gate.

**Where the platform lives:** Inside `orchestrator/`, not a new microservice. Tool dispatch and permissions already live there. Can be extracted to a `capability-broker` service later if growth demands it.

## 5. Capability surface (v1: GitHub)

A new tool group `github_external` (distinct from the existing `GitHub`/Self-Modification group). Nine tools, organized by blast-radius tier:

```
READ TIER (auto, no consent)
  list_workflow_runs(repo, status?, branch?)
  get_workflow_run(repo, run_id)
  get_run_logs(repo, run_id, job_id?)        ← annotations + log content
  get_run_diff(repo, run_id)                 ← PR's changes vs base
  compare_to_main(repo, run_id)              ← bug-locator: PR vs main

PROPOSE TIER (auto, no consent — diagnostic output only, no external mutation)
  diagnose_failure(run_id) → DiagnosisReport
  draft_fix(diagnosis) → ProposedPatch (in-memory only)

MUTATE TIER (consent required, async one-click approve)
  open_fix_pr(repo, branch, patch, base) → pr_url
  comment_on_pr(repo, pr_number, body) → comment_url

SETUP TIER (consent required at first watched-repo add; MUTATE-classified)
  register_webhook(repo, events, target_url, secret) → hook_id
  unregister_webhook(repo, hook_id)
  verify_webhook(repo, hook_id)            ← READ — health check
```

**Branching heuristic** (encoded in `compare_to_main` + agent prompt): default to branching off the failing branch and PR back into it; switch to branching off main when the failing test also fails on main's recent CI history or references files not modified in the PR's diff. This ensures fixes go where the bug lives, not where it was discovered.

**Out of v1:** repo creation, workflow YAML edits, force-push, branch-delete, secret access, releases, cross-org access. Watched repos must be under `jeremyspofford/*`.

**Webhook self-bootstrapping (added):** when a user adds a watched repo via the dashboard, Nova generates a per-hook HMAC secret, calls `POST /repos/.../hooks` to create the `workflow_run` webhook, stores `(hook_id, encrypted_secret, target_url)` in a new `github_webhooks` table, and verifies via the ping event. No manual GitHub-side configuration is required from the user — the credential just needs `admin:repo_hook` scope. If creation fails (scope missing, network error, repo lacks permission), Nova falls back to polling-only for that repo and surfaces the failure in the dashboard. `register_webhook` is a SETUP-tier MUTATE call that goes through the consent gate at first add — exercising the consent platform at setup time, not just runtime.

**Required PAT scopes:** `repo`, `workflow:read`, `admin:repo_hook`. Dashboard credential-add flow surfaces this; if `admin:repo_hook` is absent, the "Webhook + polling fallback" option in the watched-repo form is greyed out and only "Polling only" remains selectable.

**ToolGroup naming:** the registry's existing `GitHub` group keeps display_name `Self-Modification` (Nova's own repo). The new `github_external` group's display_name should be `GitHub (External Repos)` so the dashboard's permissions grid clearly distinguishes the two.

## 6. Credential vault

### 6.1 Reuse what exists

Nova already has `knowledge_credentials` (migration `041_knowledge_schema.sql`) and a shared `nova_worker_common.credentials` package with `CredentialProvider` interface and pluggable backends (`builtin`, `vault`, `onepassword`, `bitwarden`). The new capability vault uses the same backend abstraction — users with HashiCorp Vault, 1Password, or Bitwarden bring their own backend without changing app code.

**Naming divergence (intentional):** the existing `knowledge_credentials` table uses column `provider` for the *backend* (`builtin`/`vault`/`onepassword`/`bitwarden`). The new `capability_credentials` table renames that to `backend` and introduces `provider_kind` for the *auth target* (`github`/`gitlab`/`aws`/...). This is clearer (auth target ≠ vault backend) and is the model going forward; aligning `knowledge_credentials` to match is deferred until a future migration sweep — out of scope here.

### 6.2 New schema

```sql
-- New migration: 0XX_capability_credentials.sql
CREATE TABLE capability_credentials (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    user_id           UUID,
    provider_kind     TEXT NOT NULL,        -- 'github','gitlab','cloudflare','aws',...
    auth_method       TEXT NOT NULL CHECK (auth_method IN ('pat','github_app','oauth')),
    label             TEXT NOT NULL,
    backend           TEXT NOT NULL DEFAULT 'builtin'
                        CHECK (backend IN ('builtin','vault','onepassword','bitwarden')),
    encrypted_data    BYTEA,
    external_ref      TEXT,
    key_version       INTEGER NOT NULL DEFAULT 1,
    scopes            JSONB,
    expires_at        TIMESTAMPTZ,
    last_validated_at TIMESTAMPTZ,
    health            TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (health IN ('healthy','expired','revoked','invalid','unknown')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cap_creds_tenant ON capability_credentials(tenant_id);
CREATE INDEX idx_cap_creds_kind ON capability_credentials(tenant_id, provider_kind);

CREATE TABLE capability_credential_audit (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id UUID NOT NULL REFERENCES capability_credentials(id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL,
    action        TEXT NOT NULL CHECK (action IN
                    ('store','retrieve','rotate','delete','validate','use')),
    actor         TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
    success       BOOLEAN NOT NULL DEFAULT true,
    detail        TEXT
);
```

### 6.3 Key design choices

- **Credential typed by auth target, not consumer.** A GitHub PAT is `provider_kind='github'`, regardless of whether a native tool or MCP server uses it. One credential row serves any consumer that needs `kind=github`.
- **`auth_method` enum from day one.** Swapping a user from PAT to GitHub App becomes a row update, not a schema migration. v1 ships with PAT; GitHub App support layered later.
- **`tenant_id` + `user_id` always populated.** v1 single-user, but multi-tenant SaaS later flips a switch, not a migration.
- **Health dot in UI.** Cortex `maintain` drive runs weekly validation: GitHub PAT → `GET /user`, Cloudflare → `verify`, AWS → `sts:GetCallerIdentity`. Result writes `health` and `last_validated_at`. Dashboard shows green/yellow/red.

### 6.4 MCP servers as credential consumers

Extend `mcp_servers` registry to declare credential needs:

```sql
ALTER TABLE mcp_servers ADD COLUMN credential_kind TEXT;
ALTER TABLE mcp_servers ADD COLUMN credential_id   UUID REFERENCES capability_credentials(id);
```

**Injection strategies (platform-owned, transparent to MCP authors):**

| MCP transport | Injection | Lifecycle |
|---|---|---|
| HTTP MCP | Per-call header injection from vault | Stateless — rotation is instant |
| stdio MCP | Process spawned with env var; pool keyed by `(server_id, credential_id, key_version)` | Rotation triggers graceful restart |

For high-blast-radius providers, prefer HTTP MCP (per-call injection, instant rotation) over stdio MCP (long-lived process holds secret in env). UI surfaces this distinction.

### 6.5 API surface

```
GET    /api/v1/capabilities/credentials              # list, masked
POST   /api/v1/capabilities/credentials              # create + validate-before-store
GET    /api/v1/capabilities/credentials/{id}         # detail, no secret
DELETE /api/v1/capabilities/credentials/{id}         # revoke + audit
POST   /api/v1/capabilities/credentials/{id}/test    # re-validate now
```

API never returns the secret value. Audit detail is masked per the existing `feedback_no_secret_values` policy (`<first-8>…<last-4>`).

### 6.6 Dashboard UI

`Settings → Connections → Connected Services` (new panel alongside existing Remote Access and Chat Integrations):

```
Connected Services
  ● Personal GitHub          github / PAT          [healthy 2d]
    used by: native github_external, github-mcp-server
  ● Personal GitLab          gitlab / PAT          [healthy 1d]
    used by: gitlab-mcp-server
  + Add Connection ▾
    GitHub • Cloudflare • AWS • Azure • GCP • + MCP Server...
```

## 7. Consent & blast-radius

### 7.1 Four-tier model

| Tier | Default policy | UX | v1 examples |
|---|---|---|---|
| **READ** | Auto | Silent; audit-logged | `list_workflow_runs`, `get_run_logs`, `compare_to_main` |
| **PROPOSE** | Auto | Output to chat / dashboard; no external mutation | `diagnose_failure`, `draft_fix` |
| **MUTATE** | Consent required | Inline approval card + Pending Approvals panel | `open_fix_pr`, `comment_on_pr` |
| **DESTRUCT** | Consent + typed confirm | Two-step: approval card AND user types resource name | (none in v1) |

### 7.2 ToolDefinition extension (in `nova-contracts/`)

```python
class BlastRadius(str, Enum):
    READ      = "read"
    PROPOSE   = "propose"
    MUTATE    = "mutate"
    DESTRUCT  = "destruct"

class ToolDefinition(BaseModel):
    name: str
    description: str
    schema: dict
    blast_radius: BlastRadius              # required
    reversible: bool = True                # determines one-click vs typed-confirm for MUTATE
    rate_limit_per_hour: int | None = None # defense in depth
```

### 7.3 MCP tool auto-classification

Three-step pipeline at MCP server registration time:

1. **Annotation** — if the MCP server's tool metadata declares blast-radius, use it.
2. **Heuristic** — by tool-name verb: `list_*`, `get_*`, `describe_*`, `read_*` → READ; `create_*`, `add_*`, `update_*`, `set_*` → MUTATE; `delete_*`, `destroy_*`, `terminate_*`, `force_*` → DESTRUCT.
3. **Manual override** — admin re-tier in dashboard, audit-logged. Auto-classified tools surface in dashboard with a "review classification" prompt.

Default for unclassified: MUTATE (fail safe — better to over-prompt than under-protect).

### 7.4 Schemas (`approval_requests`, `consent_rules`)

```sql
-- Approval queue rows for MUTATE/DESTRUCT calls awaiting consent
CREATE TABLE approval_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    task_id         UUID,                              -- ties to orchestrator task
    requested_by    TEXT NOT NULL,                     -- agent or drive name
    tool_name       TEXT NOT NULL,
    tool_kind       TEXT NOT NULL CHECK (tool_kind IN ('native','mcp_http','mcp_stdio')),
    blast_radius    TEXT NOT NULL CHECK (blast_radius IN ('mutate','destruct')),
    args_redacted   JSONB NOT NULL,
    diff_preview    TEXT,                              -- e.g. unified diff for open_fix_pr
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','timeout','superseded')),
    decided_by      TEXT,                              -- user id when approved/rejected
    decided_at      TIMESTAMPTZ,
    rule_id         UUID,                              -- set when auto-approved by a rule
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL               -- default now() + 24h
);
CREATE INDEX idx_approval_pending ON approval_requests(tenant_id, status, expires_at)
    WHERE status = 'pending';

-- Auto-approve rules from "approve & remember" or cortex outcome-feedback proposals
CREATE TABLE consent_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID NOT NULL,
    tool_name       TEXT NOT NULL,
    provider_kind   TEXT NOT NULL,
    scope_match     JSONB NOT NULL,                    -- structured filters: target glob,
                                                       -- max_diff_lines, blast_radius, etc.
    source          TEXT NOT NULL CHECK (source IN ('user_remember','cortex_proposed')),
    proposed_at     TIMESTAMPTZ,                       -- when cortex proposed (if applicable)
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_applied_at TIMESTAMPTZ,
    apply_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_consent_rules_lookup ON consent_rules(tenant_id, user_id, tool_name)
    WHERE enabled = true;
```

`scope_match` example: `{"target_glob":"repos/jeremyspofford/*","max_diff_lines":10,"failure_signature":"eslint:*"}`. Evaluator does an AND-of-keys match against the incoming request's normalized fields. v1 ships with three matcher kinds (`target_glob`, `max_diff_lines`, `failure_signature`); more added on demand.

### 7.5 Consent state machine

```
agent calls tool
       │
       ▼
classifier (READ/PROPOSE → execute; MUTATE/DESTRUCT → consent_required)
       │
       ▼  MUTATE
create approval_request row
   • tool, args (preview), blast_radius, diff/dry_run
   • requested_by, expires_at = now + 24h
       │
       ├── user approves       → execute → audit
       ├── user rejects        → tool returns 'user_rejected'
       ├── user "approve & remember" → insert consent_rules row → execute → audit
       └── timeout (24h)       → tool returns 'consent_timeout'
```

Consent rules are evaluated *before* creating an approval request; matching rules auto-approve and audit with `event_type='rule_apply'`.

### 7.6 Approval UX

**Inline (chat-triggered):**

```
[Nova] I diagnosed the lint failure on PR #142 and drafted a fix.
┌───────────────────────────────────────────────────────────┐
│ Open PR `nova-fix-ci/abc123` against `feature-branch`?    │
│   • Diff: 3 lines changed in `src/utils.ts` (preview ▸)   │
│   • Blast: MUTATE (reversible)                            │
│   [ Approve ]   [ Reject ]   [ Approve & remember rule ]  │
└───────────────────────────────────────────────────────────┘
```

**Pending Approvals panel** — for autonomous-loop-triggered actions when the user wasn't in chat. Top-nav badge shows count.

## 8. Audit log

### 8.1 Schema

```sql
CREATE TABLE capability_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

    actor_kind      TEXT NOT NULL CHECK (actor_kind IN
                       ('agent','human','cortex_drive','cron','webhook')),
    actor_id        TEXT NOT NULL,
    task_id         UUID,

    event_type      TEXT NOT NULL CHECK (event_type IN
                       ('tool_call','consent_request','consent_decision',
                        'credential_use','mcp_register','tier_override',
                        'rule_apply','budget_exceeded')),
    tool_name       TEXT,
    tool_kind       TEXT CHECK (tool_kind IN ('native','mcp_http','mcp_stdio')),
    blast_radius    TEXT,

    provider_kind   TEXT,
    target          TEXT,                          -- 'repos/jeremyspofford/nova/pulls/142'
    credential_id   UUID,                          -- ref only, NEVER the value

    args_redacted   JSONB,                         -- secrets masked at insert
    response_status TEXT NOT NULL CHECK (response_status IN
                       ('success','rejected','error','rate_limited','timeout')),
    response_summary TEXT,
    error_class     TEXT,
    duration_ms     INTEGER,

    prev_hash       BYTEA NOT NULL,
    content_hash    BYTEA NOT NULL
);

CREATE INDEX idx_audit_tenant_time ON capability_audit(tenant_id, timestamp DESC);
CREATE INDEX idx_audit_task        ON capability_audit(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_audit_target      ON capability_audit(target);

CREATE RULE capability_audit_no_update AS ON UPDATE TO capability_audit DO INSTEAD NOTHING;
CREATE RULE capability_audit_no_delete AS ON DELETE TO capability_audit DO INSTEAD NOTHING;
```

Postgres `RULE ... DO INSTEAD NOTHING` is belt-and-suspenders: even compromised app code cannot UPDATE/DELETE; only a privileged DBA role with explicit RULE bypass can purge.

### 8.2 Hash chain

Each row: `content_hash = sha256(prev_hash || canonical_json(row_excluding_hashes))`. Per-tenant chain (no cross-tenant coordination). Nightly `maintain` drive job re-walks each tenant's chain; any break is reported as a security event.

### 8.3 Redaction policy (insert-time)

- Pattern-based mask: `Authorization:`, `Bearer `, `sk-`, `ghp_`, `cf_`, `AKIA`, `xoxb-`, etc. → `<first-8>…<last-4>`.
- Field-name mask: keys matching `/(token|secret|password|api[_-]?key|credential)/i` → whole-value masked.
- Provider-specific extensions (Cloudflare zone secrets, AWS session tokens) layered onto defaults.
- Re-redaction at API read endpoints (defense in depth).

### 8.4 Dashboard

`System → Audit Log` panel. Filters: time range, actor, tool, target, blast-radius, status. Per-task view links from the tasks panel. Export to JSON / CSV.

### 8.5 Relationship to existing audit infrastructure

`capability_audit` is purpose-specific: external-action security/compliance record. Existing `orchestrator/app/audit.py` (76 LOC) and `activity.py` (26 LOC) handle operational events (auth attempts, etc.). Different retention, different sensitivity, different consumers. Two clean tables beat one tangled one.

## 9. Cortex wiring (autonomous loop)

### 9.1 Trigger sources (per repo, three-tier ingress story)

| Tier | Setup | Latency | Works for |
|---|---|---|---|
| **Polling** (always available) | Zero config — credential + watchlist only | Up to 15 min | Everyone, including self-hosted Nova without public ingress |
| **Direct webhook** (v1 default when ingress available) | **Nova creates the hook itself** at `add watched repo` time via `register_webhook` tool. User does no GitHub-side configuration. | Seconds | SaaS, self-hosted with `cloudflared` / ngrok / public IP |
| **Managed webhook proxy** (v2 future) | User connects self-hosted Nova to a Nova-managed proxy that queues incoming webhooks; instance long-polls to drain | Seconds | Self-hosted without public ingress |

**Webhook bootstrap flow** (when user has public ingress and `admin:repo_hook` scope):

```
[User] Add Watched Repo → Trigger: ●(Webhook + polling fallback)
       │
       ▼
[Nova] generates HMAC secret; consent gate fires (MUTATE on third-party repo)
       │
       ▼  approved (one-time per repo)
[Nova] POST /repos/.../hooks { events:['workflow_run'], url, secret, content_type:'json' }
       │
       ▼
[Nova] stores in github_webhooks table; verifies via ping event → status='verified'
       │
       ▼
cortex.quality drive uses webhooks for this repo;
polling acts as failsafe (re-fires every 60 min to catch dropped events)
```

**Webhook target endpoint:** `POST /api/v1/webhooks/github` on **orchestrator** (HMAC-validated against the *decrypted* secret retrieved via the credential vault backend; new router file `orchestrator/app/webhooks_router.py`). Validates payload, writes a stimulus row in cortex DB via internal HTTP call.

**Status state machine for `github_webhooks.status`:**

```
pending  ──register_webhook API call succeeded──► active
active   ──ping event verified at target──────► verified
verified ──ping fails on health check─────────► failed
verified ──user removes watched repo──────────► revoked
failed   ──automatic re-bootstrap succeeds────► verified
```

`pending` is the row's state between the consent approval and the API call returning; `active` means GitHub has the hook but Nova hasn't yet seen a ping; `verified` is the steady-state. Most rows transition `pending → active → verified` within seconds of approval.

**Auto re-bootstrap consent:** the first `register_webhook` call for a repo goes through the consent gate explicitly. At that approval, Nova auto-inserts a `consent_rules` row scoped to `tool=register_webhook, target=<this-repo>` so subsequent re-bootstraps (after webhook-failure detection) auto-approve under that rule. The user can remove the rule from the dashboard's auto-approve rules manager to revert to manual-consent for re-bootstraps. This keeps the user in control without consent-card spam during normal recovery.

**Polling singleton election:** even with webhooks as primary, polling is the always-on fallback (catches dropped webhook events). Polling is run by exactly one orchestrator instance at a time, elected via Redis lease (`nova:poll:github:lease`, 5-min TTL, refreshed every 60s). Multi-instance SaaS deployments avoid duplicate API calls; v1 single-instance pays nothing for this.

**Webhook health monitoring:** cortex `maintain` drive runs daily, pinging each `github_webhooks` row's hook_id. Failed pings → status='failed' → dashboard surfaces an alert and Nova re-bootstraps the webhook automatically (next scheduled `maintain` run).

### 9.1.1 New schema: `github_webhooks`

```sql
CREATE TABLE github_webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    credential_id   UUID NOT NULL REFERENCES capability_credentials(id),
    repo            TEXT NOT NULL,                          -- 'jeremyspofford/some-repo'
    hook_id         BIGINT NOT NULL,                        -- GitHub-issued, used for delete/update
    target_url      TEXT NOT NULL,
    encrypted_secret BYTEA NOT NULL,                        -- HMAC secret, vault-encrypted
    events          TEXT[] NOT NULL,                        -- ['workflow_run']
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','verified','failed','revoked')),
    last_event_at   TIMESTAMPTZ,                            -- last received webhook event
    last_pinged_at  TIMESTAMPTZ,                            -- last health check
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_github_webhooks_repo ON github_webhooks(tenant_id, repo);
```

**Constraint note:** `UNIQUE(tenant_id, repo)` is correct for v1 (one `workflow_run` hook per repo). Future slices that add additional event types per repo (e.g., `push`, `pull_request_review`) need to widen this to `UNIQUE(tenant_id, repo, hook_id)` and enforce per-event-type uniqueness via partial indexes — flagged in §11.

### 9.2 Stimulus → Goal → Task

```
GitHub Actions failure
       │
       ▼  (poll or webhook)
cortex inserts stimulus row
       │
       ▼
quality drive evaluates:
   • repo in watchlist?
   • failure already being triaged? (dedup by run_id)
   • daily budget remaining? (cortex.budget — existing module)
   • active hours window?
       │
       ▼  yes to all
cortex creates Goal: "Triage failed CI on <repo>/<run_id>"
       │
       ▼  maturation phases (existing): scoping → speccing → triage → building → verifying
       │
       ▼
orchestrator task created with pod=ci_triage_agent
       │
       ▼
Redis BRPOP picks up task, Quartet pipeline runs:
   Context → Task → Guardrail → Code Review → Decision
       │
       ▼
Task agent calls capability-platform tools
   READ tier auto, MUTATE tier through consent gate
       │
       ▼
outcome recorded → cortex feedback → updates rule candidates
```

### 9.2.1 Pod separation: `ci_triage_agent` vs setup-time tools

Webhook lifecycle tools (`register_webhook`, `unregister_webhook`, `verify_webhook`) are **admin-tier setup actions** triggered by the dashboard's watched-repo form, not part of the runtime triage agent's tool set. The `ci_triage_agent` pod (defined below) explicitly excludes them — the agent never needs to manage webhooks during a triage task. This prevents over-broad pod permissions and means an agent prompt-injection at runtime cannot register or remove webhooks.

Setup-time webhook calls run under a lightweight system-only execution path (no LLM agent loop): the dashboard form submits to an orchestrator endpoint that resolves the credential, calls the consent gate, runs the `register_webhook` tool directly, and writes the audit row. Same machinery, different invocation path.

### 9.3 New agent pod: `ci_triage_agent`

Stored in DB (existing pattern), editable via dashboard's Agent Management UI:

```yaml
name: ci_triage_agent
display_name: "CI Triage Agent"
description: "Triages failed GitHub Actions runs and proposes fixes"
allowed_tool_groups:
  - github_external      # NEW
  - Code                 # read-only file access
  - Memory               # recall past triages, style preferences
  - Diagnosis            # service health if needed
model_classification: code   # gateway routes to code-tuned models
max_turns: 12
system_prompt: |
  You triage failed CI runs on GitHub repos.
  First, call compare_to_main to locate where the bug lives.
  Read logs with get_run_logs to identify the failing step.
  Diagnose the root cause. Recall past triages from Memory for similar failures.
  Draft a minimal patch (touch only files implicated by the failure).
  Open a PR with the fix targeting the correct base branch.
  If diagnosis is uncertain or patch is risky, comment on the PR with diagnosis only.
```

### 9.4 Quartet as outer safety wrapper

Capability platform consent gate is the *inner* safety layer (per-tool-call). Quartet is the *outer* safety layer (per-task). They stack:

| Quartet stage | Adds for CI triage |
|---|---|
| Context | Pulls memory: past triage outcomes, style preferences. Pauses for clarification on novel failure types. |
| Task | Does the work, calls tools, hits consent gate at first MUTATE call. |
| Guardrail | Verifies fix doesn't touch unrelated files, doesn't disable tests, diff size ≤ 50 lines. |
| Code Review | Re-runs **the failing job from the original run** locally (using the repo's existing CI config — no novel tooling) against the patched files, before opening the PR. v1 does not invent custom lint/type tooling for arbitrary repos. |
| Decision | Final go/no-go; can downgrade "open PR" → "comment only" if risk signals are high. |

### 9.5 Outcome feedback (path to tier E)

After every triage, cortex records:

- PR merged? (positive)
- CI passed after merge? (positive)
- PR closed without merging? (negative)
- User edited Nova's patch before merging? (learning signal)

Cortex uses these to *propose* auto-approve rules:

> *"In the last 30 days I correctly diagnosed and fixed 14 lint failures and 9 missing-import failures across `jeremyspofford/*`. Want to auto-approve `open_fix_pr` for these failure-types going forward?"*

User accepts → row inserted into `consent_rules`. Tier E emerges from data, not policy.

### 9.6 Configuration UI

`Settings → Connections → Connected Services → GitHub` adds a per-credential **CI Triage** tab:

```
CI Triage
  Watched repos:    [jeremyspofford/nova ✓]
                    [jeremyspofford/dotfiles ✓]
                    [+ Add repo ▾]
  Trigger:          (•) Polling  ( ) Webhook  ( ) Both
  Polling interval: [15 min ▾]
  Workflows:        (•) All  ( ) Pattern: [tests*    ]
  Active hours:     [Always ▾]
  Daily budget:     [20 triages]   (cortex.budget caps this)
  Auto-approve rules: [3 active] [Manage…]
```

## 10. Testing strategy

### 10.1 Pyramid

```
Smoke (opt-in)    : ~5 tests, nightly, REQUIRES_GITHUB=1, real api against jeremyspofford/nova-test-cap
E2E integration   : ~15 tests, every CI run, real Nova stack + fake-github at boundary
Component         : ~30 tests, real DB/Redis, isolated services
Unit              : ~40 tests, pure functions (redactor, hasher, classifier)
```

### 10.2 fake-github service

New FastAPI service in `tests/fixtures/fake-github/`. Implements the GitHub REST subset Nova actually calls; HMAC support for webhooks; canned responses driven by per-test scenario JSON. Started by pytest fixtures, listens on a per-test ephemeral port.

**This is a *boundary* fake at the GitHub API edge — not a Nova service mock.** Tests still hit the real Nova stack (orchestrator, cortex, memory, llm-gateway, postgres, redis) per the project's no-mocks-for-internal-services rule. The fake replaces only the third-party network endpoint Nova would otherwise call. This is the same pattern Nova already uses for LLM providers in pipeline tests. Future Cloudflare/AWS work follows the same harness shape.

### 10.3 Critical scenarios (must-have)

**Credential vault (10 tests)** — store/retrieve/rotate; encryption with key rotation; audit on every action; tenant isolation; health validation 200/401/403; pluggable backend stubs; secret never returned by API; expiry → blocked tool calls; MCP credential resolution; stdio rotation triggers restart.

**Consent gate (8 tests)** — READ/PROPOSE auto; MUTATE creates approval; approve/reject/timeout paths; "approve & remember" creates rule; consent rule scope boundaries.

**Audit hash chain (5 tests)** — chain validity over N rows; tampering detection; per-tenant isolation; UPDATE/DELETE silently rejected by DB rule; concurrent insert correctness.

**Redaction (4 tests)** — secret patterns masked; field-name patterns masked; provider-specific extensions; read-endpoint re-redaction.

**End-to-end CI triage (5 tests)** — bug-in-PR; bug-on-main; ambiguous → pause; unfixable → comment-only; budget cap enforced.

**Real-GitHub smoke (5 tests, opt-in)** — list runs; open + close test PR; comment + delete; credential validation; webhook delivery → triage. Run nightly + before tagged releases.

### 10.4 Fixtures

```python
@pytest.fixture
async def fake_github(unused_tcp_port):
    server = FakeGitHubServer(port=unused_tcp_port)
    await server.start()
    yield server
    await server.stop()

@pytest.fixture
async def github_credential(fake_github, db):
    cred = await capability_credentials.create(
        provider_kind="github",
        auth_method="pat",
        label="nova-test-pat",
        secret="ghp_fake_token_for_tests",
        api_base=f"http://localhost:{fake_github.port}",
    )
    yield cred
    await capability_credentials.delete(cred.id)
```

Test resources prefixed `nova-test-` per existing convention; teardown via fixtures.

## 11. Future slices (post-v1, sketched)

| Slice | Lift | Adds to platform |
|---|---|---|
| GitHub repo creation + bootstrap | Small | New tools in same `github_external` group; no new platform pieces |
| Cloudflare DNS management | Medium | First MCP-based provider; first non-GitHub credential kind; exercises MCP-credential path |
| Cross-org GitHub access | Small | Per-credential repo-scope filter |
| AWS read-heavy operations | Medium | First "use MCP for read, native for mutate" hybrid provider |
| AWS destructive operations | Large | First DESTRUCT-tier tools; typed-confirm UX; per-resource blast-radius caps |
| Per-task workspace (build/test/deploy in browser) | Largest | Containerized workspace with Playwright + language toolchains; file-system sandbox; archetype D from the brainstorm |
| Tier E auto-approve rules (data-driven) | Medium | `consent_rules` table already exists; UI for review/manage; cortex proposal flow |
| **Managed webhook proxy** (v2) | Medium | Nova-hosted public endpoint receives webhooks for self-hosted instances without public ingress; queues per tenant; instances long-poll to drain. Solves the "I want webhooks but can't expose a public endpoint" gap. |
| **Multi-event-type webhooks per repo** (v1.5+) | Small | When repos need additional hook event types beyond `workflow_run` (`push`, `pull_request_review`, etc.), widen the `github_webhooks` unique constraint from `(tenant_id, repo)` to `(tenant_id, repo, hook_id)` with partial-index per-event-type uniqueness. |
| **Phone number for Nova** (v3) | Large | Twilio (or similar) integration: SMS approvals for low-blast-radius mutations, voice-call paging for budget-exceeded or anomaly events, identity binding (phone number → user), reuses approver-agnostic decision API. Likely a new `comms` microservice or extension of the existing `voice-service`. Out of v1 platform scope but architecturally compatible — the consent-gate's approver-agnostic API surface (per Q3 resolution) is exactly what makes this slot in cleanly later. |

## 12. Risks and open questions

| Risk | Mitigation |
|---|---|
| Hash chain serialization under concurrent writes | Postgres advisory lock per-tenant during insert; tested at 50 parallel writes |
| MCP server with unannotated tools auto-classified wrong | Default to MUTATE; surface in dashboard for admin review at registration |
| Stdio MCP holding secret in process memory | Document risk; surface in UI; recommend HTTP MCP for high-blast providers |
| Runaway autonomous loop on flaky CI | Daily budget cap (default 20/day) via existing `cortex.budget` |
| Consent fatigue | Tier E (data-driven auto-approve) explicitly designed for this; cortex *proposes*, user accepts/rejects |
| Credential rotation breaking long-running stdio MCP processes | Process pool keyed by `key_version`; graceful restart on rotation |
| Cross-tenant audit log access | Per-tenant chain; queries always scoped by `tenant_id`; tested |

### Resolved decisions (post-brainstorm)

1. **`github_external` stays separate from `GitHub` (Self-Modification) for v1.** Plan to merge in a future migration once `consent_rules` is mature enough to express "self-modification requires extra confirmation" without needing two groups.
2. **Singleton-elected polling via Redis lease.** Even though v1 single-instance pays nothing for this, the design avoids the multi-tenant rate-limit time bomb later. Polling is the always-on fallback even with webhooks as primary trigger.
3. **Dashboard-only approval surface for v1, but the decision API is approver-agnostic.** The `approval_requests` row records `decided_via TEXT` ('dashboard' | 'slack' | 'telegram' | 'sms' | 'voice' | 'cli'); the `POST /api/v1/capabilities/approvals/{id}/decide` endpoint accepts any authenticated client. v1.5 adds chat-bridge as a second client without backend changes; v3 adds phone-based approvals (SMS/voice via the future phone-number capability) likewise without backend changes.
4. **Webhooks default-on with self-bootstrapping** (Nova creates the hook itself when scope allows), polling-only as fallback for users without `admin:repo_hook` scope or public ingress. Eliminates the manual webhook config that originally pushed polling to be the default.

## 13. Acceptance criteria (v1 definition of done)

1. Add a GitHub PAT (scopes: `repo`, `workflow:read`, `admin:repo_hook`) via dashboard → credential row encrypted at rest, validated against real GitHub `/user` endpoint, health green.
2. Configure a watched repo with default trigger (Webhook + polling fallback) → consent card appears for `register_webhook` MUTATE; approve → webhook created on the repo, verified via ping, `github_webhooks.status='verified'`.
3. Push a commit that breaks CI on that repo.
4. Within seconds (webhook path) or 16 minutes (polling fallback), an approval card appears in the dashboard's Pending Approvals panel.
5. Approve the card. A PR opens against the failing branch with a minimal fix.
6. CI on the fix-PR passes.
7. View the audit trail for the triage task; every tool call, consent event, and credential use is recorded with hash chain intact.
8. Repeat on a second repo where the bug is on `main`; PR opens against `main` instead.
9. Configure a daily budget of 1; trigger 2 failures; second is skipped with `event_type=budget_exceeded`.
10. All ~75-90 unit/component/E2E tests pass; ~5 opt-in smoke tests pass against real GitHub when `REQUIRES_GITHUB=1`.

---

**Next step after spec approval:** invoke `superpowers:writing-plans` to produce a step-by-step implementation plan, sequenced for incremental shippability (vault first, then audit, then consent, then GitHub provider, then cortex wiring, then UI).
