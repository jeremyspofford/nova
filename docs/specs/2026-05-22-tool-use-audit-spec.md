# Nova v2 Tool-Use Audit — Spec

> **Status:** Draft for review
> **Date:** 2026-05-22
> **Branch:** `engineer/agent-actually-uses-tools`
> **Worktree:** `.worktrees/engineer-agent-actually-uses-tools/`
> **Driven by:** `/engineer agent-actually-uses-tools` (visionary-pass proposal #3, 2026-05-22)

---

## Goal

Establish whether Nova v2's conversational agent actually uses its registered tools when prompted to. For each tool, distinguish three failure modes:

1. **Didn't reach for it** — the model produced text-only output and never proposed the tool.
2. **Reached but the tool errored** — the model proposed the tool, but the tool returned an error (e.g., workspace sandbox rejection, missing config).
3. **Reached and the side effect actually happened** — the model proposed the tool, the tool returned success, and an independent check confirms the observable outcome.

Produce a baseline report that is *comparable across model swaps* so future regressions are detectable in measurement, not just felt.

**Primary artifacts:**

- `docs/audits/2026-05-22-tool-use-audit.md` — human-readable report.
- `docs/audits/2026-05-22-tool-use-audit/results.json` — machine-readable companion for run-to-run diffing.
- `docs/audits/2026-05-22-tool-use-audit/traces/{probe_id}__{model}__t{N}.json` — full per-trial ReAct traces.

**Primary evidence:** per-tool 4-level outcome rates (`NOT_CALLED` / `CALLED_ERROR` / `CALLED_OK` / `SIDE_EFFECT_VERIFIED`) per model, plus an orthogonal `SKIPPED` axis for tool-not-available.

**Why this task exists:** the user reports v2 *"doesn't appear to be able to do things,"* yet code inspection shows the tools are wired (`agent-core/app/tasks_router.py:182-190` `_CHAT_TOOL_NAMES`) and individual tool implementations exist (`agent-core/app/tools/tools_builtin/{fs,shell,code,memory,nova_tools,web}.py`). This audit produces evidence — does the conversational agent actually exercise its tools? If not, is the cause in the model, the prompt, or the wiring? Fixes are *out of scope*; this task produces the diagnostic.

---

## Non-Goals

This task explicitly does NOT:

- Modify any tool implementation (`agent-core/app/tools/tools_builtin/*.py`).
- Modify the agent system prompt or LLM routing logic in `tasks_router.py`.
- Add the audit to CI gates — it is diagnostic only, never blocking.
- Outcome-verify `browser_navigate` (ships attempt-only; revisit in follow-up).
- Side-effect-verify `web.search` / `web.fetch` (response-content verification only; deeper outcome verification deferred).
- Introduce any new service, container, or python dependency beyond what `tests/` already uses (`httpx`, `pytest`, `pytest-asyncio`, `python-dotenv`).
- Add a `/api/v1/tools` public listing endpoint (audit infers from `/api/v1/mcp/servers` + the static builtin list).

Any prompt-engineering / tool-rename / forced-routing fixes that emerge from findings become *follow-up tasks*, not part of this one.

---

## Approach

Six small components, declarative probes, one uniform run loop. The asymmetry — *probes are data, verifiers are typed strategies, harness is one loop* — is what lets the audit grow without growing the code.

```
tests/audit_tool_use/
├── __init__.py
├── probes.py        # data: list[Probe] — declarative records
├── verifiers.py     # 3 verifier classes + SKIP sentinel
├── harness.py       # uniform per-(probe, model, trial) run loop
└── render.py        # results → markdown + JSON + traces
tests/test_chat_tool_usage.py     # pytest entry; orchestrates harness
Makefile                          # `audit-tool-use:` target
docs/audits/2026-05-22-tool-use-audit/
├── results.json
└── traces/{probe_id}__{model}__t{N}.json
docs/audits/2026-05-22-tool-use-audit.md
```

### 1. Probe registry (`tests/audit_tool_use/probes.py`)

Flat list of ~9-12 `Probe` records:

```python
@dataclass(frozen=True)
class Probe:
    id: str                                # stable id used throughout report
    tool: str                              # original (dotted) tool name expected
    prompt_template: str                   # uses {run_id}, {token} placeholders
    expected_args_subset: dict | None      # optional: subset that must appear in tool_call_proposed args
    verifier: Verifier                     # FileExists | DbContains | ResponseContains | SKIP
    cleanup: Cleanup                       # what to delete after the probe runs
    tier: Literal["READ", "MUTATE"]        # determines wall-clock deadline + approval expectation
    preconditions: list[Precondition]      # e.g. CredentialMasterKeyConfigured for secrets probes
```

Probes are data; adding a tool means appending a row. Initial set covers: `fs.write`, `fs.read`, `shell.exec`, `code.execute`, `memory.write`, `memory.search`, `nova.secrets.write`, `nova.secrets.read`, `web.fetch`, `web.search`, `browser_navigate` (attempt-only).

### 2. Verifier strategies (`tests/audit_tool_use/verifiers.py`)

Three concrete strategies plus a `SKIP` sentinel:

| Strategy | Reads from | Covers |
|---|---|---|
| `FileExists(path, expect_content_contains)` | host filesystem (path scoped to `NOVA_WORKSPACE`) | `fs.write` |
| `DbContains(endpoint, query, expect_field)` | HTTP — memory-service `/memories/search`, agent-core `/api/v1/secrets/resolve` | `memory.write`, `nova.secrets.write` |
| `ResponseContains(token)` | the model's final assistant text | `fs.read`, `shell.exec`, `code.execute`, `memory.search`, `nova.secrets.read`, `web.fetch`, `web.search` |
| `SKIP` | — | `browser_navigate` (attempt-only) |

Each strategy is ~15 lines, stateless, instantiated per trial. No direct database access — `DbContains` goes through service HTTP APIs.

### 3. Audit harness (`tests/audit_tool_use/harness.py`)

The single per-`(probe, model, trial)` loop:

1. **Load `.env`** via absolute path `/home/jeremy/workspace/nova/.env` (fail loud if missing — never silently fall back to a default secret). Allow `NOVA_ADMIN_SECRET` env override.
2. **Preconditions.** Check probe preconditions (e.g. `CREDENTIAL_MASTER_KEY` set for secrets probes). Missing precondition → `SKIPPED("precondition: {reason}")`.
3. **Tool availability check.** For builtin tools (`fs.*`, `shell.*`, `code.*`, `memory.*`, `nova.secrets.*`, `web.*`) — always available. For MCP tools (`browser_*`) — query `GET /api/v1/mcp/servers`, look for a server whose discover output includes the expected tool name. If absent → `SKIPPED("mcp-not-registered")`.
4. **Create task.** `POST /api/v1/tasks` with `{"prompt": rendered_prompt, "source": "audit", "model": model_id}` → returns `task_id`.
5. **Stream message.** `POST /api/v1/tasks/{task_id}/message` with `{"text": rendered_prompt}`. Consume the response as NDJSON line-by-line (`httpx.AsyncClient.stream` + `aiter_lines` + `json.loads(line)`). Stop on stream close (no terminal sentinel exists in the protocol).
6. **Concurrent approval grant.** While consuming the stream, watch for `{"type":"tool_approval_request","tool_call_id":...,"name":...,"tier":...}`. Immediately `POST /api/v1/approvals/{tool_call_id}/grant` in a parallel `asyncio.create_task` so the in-flight tool unblocks before the 300s `capability.py:97` `APPROVAL_TIMEOUT_S` fires. Grant at most once per `tool_call_id`.
7. **Wall-clock deadline.** 90s for READ-tier probes, 120s for MUTATE-with-auto-grant. Expiration → record `AUDIT_INFRA_TIMEOUT` outcome (distinct from `NOT_CALLED` and from tool failure).
8. **Extract task events.** After stream close, `GET /api/v1/tasks/{task_id}/events` → filter for the expected tool name. Determine outcome:
   - No `tool_call_proposed` event for expected tool → `NOT_CALLED`.
   - `tool_call_proposed` followed by `tool_call_error` (or `tool_call_result` payload with an `error` key) → `CALLED_ERROR`.
   - `tool_call_proposed` followed by `tool_call_result` with no `error` → `CALLED_OK`.
9. **Run verifier** (only if `CALLED_OK` and verifier is not `SKIP`). On success, escalate outcome to `SIDE_EFFECT_VERIFIED`. On failure, outcome stays at `CALLED_OK` with `verifier_failed_reason` recorded.
10. **Run cleanup** (best-effort). On failure, log warning and mark trial `cleanup_failed: true`. Cleanup failure never fails the trial.
11. **Record trial.** Per-trial record: `{probe_id, tool, model, trial_n, outcome, latency_ms, error_msg, trace_path, cleanup_failed, run_id}`.

### 4. Report renderer (`tests/audit_tool_use/render.py`)

Aggregates per-trial records into a markdown report and JSON sidecar. Outputs:

- **Markdown** at `docs/audits/2026-05-22-tool-use-audit.md`:
  - Frontmatter (date, commit SHA, models, routing strategy, run duration, totals, agent-core git SHA, audit script SHA-256).
  - TL;DR table (one row per model: tools tested, pass rate, P0 count) — under 10 lines.
  - Per-tool findings table with `severity` / `category` / `failure_rate` / `recommended_fix` / `effort`.
  - Recommendations section, ranked impact-to-effort.
  - Reproducibility block (exact `make` invocation + env vars + comparison notes).
  - Trace links as collapsed `<details>` blocks pointing to `traces/*.json`.
- **JSON** at `docs/audits/2026-05-22-tool-use-audit/results.json` — same structured data, for diffing against future runs.
- **Traces** at `docs/audits/2026-05-22-tool-use-audit/traces/{probe_id}__{model}__t{N}.json` — full per-trial trace (stream events received + task_events extracted + verifier output + cleanup outcome).

### 5. Pytest entry (`tests/test_chat_tool_usage.py`)

Single test function under `@pytest.mark.audit`:

```python
@pytest.mark.audit
@pytest.mark.asyncio
async def test_chat_tool_use_audit():
    if not await _services_reachable():
        _write_skipped_report("services unavailable")
        pytest.skip("services unavailable")
    models = await _discover_models()                        # GET /providers
    results = await run_audit(probes=PROBES, models=models, trials=3)
    render_report(results, OUTPUT_DIR)
```

The function never raises on tool-call failure — those are reported via outcome levels, not by failing the test. The pytest assertion is only on infrastructure correctness (audit ran to completion, report was written, no audit-script bugs).

### 6. Make target (`Makefile` addition)

```make
audit-tool-use: ## Tool-use audit (live services, ~10-30 min)
	@cd tests && uv run --with pytest --with pytest-asyncio --with httpx \
	  --with python-dotenv \
	  pytest -v -m audit tests/test_chat_tool_usage.py || true
```

The trailing `|| true` ensures the make target itself exits 0 even when pytest skips or fails — audit is diagnostic, never CI-blocking.

### Data flow

```
probes (data) ──┐
                ▼
              harness (per probe × model × trial)
                ▼
      per-trial records (in-memory list)
                ▼
              render
                ├──→ markdown report
                ├──→ results.json
                └──→ traces/*.json
```

---

## Design Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | NDJSON line parser; terminate on stream close | Endpoint returns `text/plain` newline-delimited JSON, not SSE (`tasks_router.py:517`). No `data:` prefix, no terminal sentinel. |
| 2 | `task_events` is the truth source for tool calls | Stream carries only `meta`/`text`/`tool_approval_request`/`error`. Tool names, args, results, errors all live in postgres `task_events`. |
| 3 | Concurrent approval-grant via `asyncio.create_task` | MUTATE tools block 300s on `capability.py:97`; grant must race the wait, not wait-then-grant. |
| 4 | N=3 trials per (probe, model) at temp 0.7 | Distinguishes "never reaches" from "intermittent" without runaway cost. Temperature is hardcoded 0.7 in `tasks_router.py`. |
| 5 | 4-level outcome × orthogonal `SKIPPED` axis | Outcome levels describe what happened; `SKIPPED` describes applicability (probe-not-applicable is not an outcome). |
| 6 | Probes are data; 3 verifier strategies | New tool = one probe row; no per-tool verifier function. |
| 7 | Run-id prefix `nova-audit-{run_id}-...` on every written entity | Cleanup is filterable; aborted runs don't permanently pollute memory. |
| 8 | Auto-discover models from `GET /providers`; per-model 5-min budget | No hardcoded model list to rot; cloud-key absence handled gracefully (provider just not listed). |
| 9 | Traces in sibling directory, referenced from collapsed `<details>` in markdown | Report stays skimmable; raw evidence still preserved per docs ACs. |
| 10 | `make audit-tool-use` exits 0 on services-down | Diagnostic, not CI gate. QA AC-Q7. |

---

## Open Questions

All resolved during brainstorm. None remaining for spec phase.

| Question | Resolution |
|---|---|
| Audit signal depth: attempt-only vs outcome-verified | Outcome-verified, with 4-level taxonomy |
| Ship `browser_navigate` probe initially? | Yes — reports cleanly as `SKIPPED` if MCP not registered |
| First-run report in same PR as harness? | Yes — frozen baseline at this commit anchors future runs |

---

## Role-specific Acceptance Criteria (reviewer gates)

These come verbatim from the ensemble-planning advisor pass. Every diff must satisfy them, or surface an explicit waiver in the PR description.

### Backend (`AC-B*`)

- **AC-B1** `.env` is loaded from `/home/jeremy/workspace/nova/.env` via absolute path; missing file produces a loud error, never a silent fallback to a hardcoded default secret.
- **AC-B2** Audit auto-grants approval for every MUTATE tool call it triggers, concurrent with stream consumption, before the 300s `capability.py:97` `APPROVAL_TIMEOUT_S` fires.
- **AC-B3** Tool-call detection reads `task_events` after stream close; per-tool outcome derives from `tool_call_result` / `tool_call_error` events, NOT from stream content.
- **AC-B4** Every task, memory, secret, and file the audit creates is cleaned up — either by direct delete or by the filterable run-id prefix.
- **AC-B5** Hard per-message wall-clock deadline: 90s for READ-tier probes, 120s for MUTATE-with-auto-grant. Expiration → `AUDIT_INFRA_TIMEOUT` outcome (distinct from `NOT_CALLED` and from tool failure).
- **AC-B6** `browser_navigate` probes report `SKIPPED("mcp-not-registered")` when Playwright MCP is not registered — never `FAILED`.
- **AC-B7** Each `(model, probe, trial)` uses a fresh `task_id`. Task context is never shared across probes, models, or trials.

### QA (`AC-Q*`)

- **AC-Q1** Each probe has a pre-run tool-availability check; missing tool → `SKIPPED`, not `NOT_CALLED`.
- **AC-Q2** Outcome reported at four levels per probe per trial: `NOT_CALLED` / `CALLED_ERROR` / `CALLED_OK` / `SIDE_EFFECT_VERIFIED`. `SKIPPED` reported on a separate axis.
- **AC-Q3** Prompts force tool use via unfalsifiable side effects — file contents the model can't fabricate, UUIDs the model can only retrieve via `memory.search`, PIDs that require `shell.exec` to obtain. Inline-answer responses are observably incorrect.
- **AC-Q4** N=3 trials per `(probe, model)`. Report records `n_attempted` / `n_called_ok` / `n_side_effect_verified`.
- **AC-Q5** `results.json` sibling file written with same per-probe/per-model/per-level counts for regression diffing.
- **AC-Q6** Probe cleanup is idempotent and runs even on test failure. Cleanup failure is `warn`, not `fail`.
- **AC-Q7** `make audit-tool-use` skips gracefully (exit 0, writes `SKIPPED: services unavailable`) when services are down. Audit is diagnostic, never CI-blocking.
- **AC-Q8** All written memories, secrets, files, and tasks use a distinctive run-id prefix `nova-audit-{run_id}-...` so cleanup is filterable post-hoc.

### Docs (`AC-D*`)

- **AC-D1** Frontmatter contains: `date`, `commit_sha`, `models_tested` (id + version + strategy), `llm_routing_strategy`, `run_duration_seconds`, `total_pass`, `total_fail`, `agent_core_git_sha`, `audit_script_sha256`.
- **AC-D2** TL;DR table at top — one row per model, columns: model, tools tested, pass rate, P0 count. Under 10 lines. Comes before any prose.
- **AC-D3** Each finding block contains: `severity` (P0/P1/P2), `category` (model/prompt/wiring/infra), `tool_name`, `failure_rate`, `recommended_fix` with effort (S/M/L), anchor link to trace evidence.
- **AC-D4** Raw traces stored in `docs/audits/2026-05-22-tool-use-audit/traces/` and referenced via collapsed `<details>` blocks in the markdown — never inlined in main findings body.
- **AC-D5** Recommended-fixes section ranked by impact-to-effort. Each fix maps back to a finding ID.
- **AC-D6** Reproducibility block at bottom: exact `make audit-tool-use` invocation, env vars affecting output, what to hold constant for valid comparison.

**Total: 21 acceptance criteria** (7 backend + 8 qa + 6 docs) — reviewer gates for ensemble-review during execution.

---

## Out of Scope

These become follow-up tasks based on audit findings:

- Any prompt-engineering fix to the agent system prompt.
- Tool renaming (sanitization quirks remain as-is).
- Forced model-routing for tool-heavy turns.
- Outcome verification for `browser_navigate`.
- Side-effect verifier for `web.search` / `web.fetch` beyond `ResponseContains`.
- Public `/api/v1/tools` listing endpoint (audit infers availability from `/api/v1/mcp/servers` + builtin list).
- CI integration of the audit.
- Auto re-run on flake detection.

---

## References

- Visionary proposal #3 — `agent-actually-uses-tools` starter spec (visionary-pass output, 2026-05-22).
- Backend advisor pass — surfaced NDJSON stream, `task_events` truth source, approval auto-grant requirement.
- QA advisor pass — 4-level outcome taxonomy, N=3 trials, side-effect verifier design.
- Docs advisor pass — frontmatter schema, TL;DR table, traces sidecar convention.
- Source-of-truth code paths:
  - `agent-core/app/tasks_router.py:182-190` — `_CHAT_TOOL_NAMES` exposure to chat
  - `agent-core/app/tasks_router.py:517` — streaming endpoint `text/plain` content-type
  - `agent-core/app/tools/capability.py:88-97` — approval-request event + 300s timeout
  - `agent-core/app/tools/tools_builtin/{fs,shell,code,memory,nova_tools,web}.py` — tool implementations under audit
