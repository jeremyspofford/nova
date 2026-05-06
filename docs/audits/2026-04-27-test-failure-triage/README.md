# Test Failure Triage — 2026-04-27

After the repo migration (`arialabs/nova` → `jeremyspofford/nova`) and P1 Autonomous Loop verification, `make test` ran with **266 passed / 63 failed / 39 skipped**. None of the failures were caused by the migration or P1 work — all are pre-existing test debt or environment drift.

## Triage outcome

| Cluster | Tests | Status | Disposition |
|---|---|---|---|
| **psycopg2 missing** | 12 | ✅ **Fixed** | Added `--with psycopg2-binary` to Makefile test target |
| **Float precision (test_sources)** | 2 | ✅ **Fixed** | `pytest.approx()` for trust_score equality |
| **Voice service auth** | 5 | 🔧 **Partial** | Tests now use `HEADERS` from env; `.env` value is stale (Redis has rotated secret). Tests will pass once `.env` is realigned with Redis or conftest reads Redis. |
| **Auth — endpoint not enforcing admin** | 5 | 🚨 **Security flag** | `test_*_requires_admin` tests expect 401/403, get 200. Real regression. See P0 below. |
| **Inference backends** | 13 | ⏭️ **Defer (env-dependent)** | Tests assume hardware/backend state that doesn't exist in this dev env (no GPU, vLLM/SGLang not running). Mark as `xfail` or environment-gate. |
| **Cortex reflections** | 12 | ✅ **Fixed** | Same psycopg2 fix |
| **Pipeline behavior** | 4 | ⏭️ **Defer (LLM-dependent)** | Failing with `500 Internal Server Error` from llm-gateway. Likely model/provider unavailable; tests need `requires_llm` marker. |
| **Memory quality** | 4 | ⏭️ **Defer (data-state-dependent)** | E.g. "topic supersession rate is 86% (3989/4658)" — test asserts on cumulative consolidation state, fragile. Needs threshold rework or fixture-based data state. |
| **Misc one-offs** | 6 | ⏭️ **Defer** | `test_memory_tools_registered` (KeyError 'name'), `test_orchestrator::test_delete_active_task_rejected`, `test_bridge_health` connection refused (chat-bridge not in default profile), `test_linked_accounts` 403/404 mismatches, `test_recovery::test_troubleshoot` 405 method-not-allowed |

## Net result of this triage session

- **14 tests fixed** by 3 trivial changes (1 Makefile line + 4 test-code lines)
- **5 tests partially fixed** (correct pattern, awaits env fix)
- **2 real issues surfaced** (`P0` admin-auth regression + `.env` ↔ Redis secret divergence)
- **40 tests deferred** with documented categories — most are env-dependent or fragile threshold-based, not actionable in a single fix pass

## P0 finding — admin auth not enforced on orchestrator

Five tests of the form `test_*_requires_admin` expect 401/403 when hitting admin endpoints without the `X-Admin-Secret` header. They get 200.

**Reproducer:**

```bash
$ curl -o /dev/null -w "%{http_code}\n" -H "X-Admin-Secret:" http://localhost:8000/api/v1/keys
200   # should be 401 — empty secret
$ curl -o /dev/null -w "%{http_code}\n" -H "X-Admin-Secret: anything-wrong" http://localhost:8000/api/v1/keys
200   # should be 401 — wrong secret
```

The voice service correctly rejects (401) when the secret doesn't match Redis. The orchestrator does not. Affected tests:

- `test_friction.py::TestFrictionCRUD::test_requires_admin_auth`
- `test_quality_scoring.py::TestQualityAPI::test_summary_requires_admin`
- `test_quality_scoring.py::TestBenchmarkAPI::test_benchmark_results_requires_admin`
- `test_tool_permissions.py::TestToolPermissionsAPI::test_requires_admin_auth`
- `test_recovery.py::TestFactoryReset::test_reset_requires_confirmation` (related — admin check possibly also weakened)

**Investigation needed:** Compare current `orchestrator/app/auth.py` admin-check logic against the `RoleDep(min_role="admin")` pattern; check whether `REQUIRE_AUTH=true` is properly threaded through admin paths or whether a refactor weakened the gate. The Phase 0 audit BACKLOG already tracks similar items in the SEC-* range; this may be a new entry or a regression of an existing one.

## P1 finding — `.env` admin secret stale relative to Redis

Voice service (and any other service that reads `nova:config:auth.admin_secret` from Redis db1) honors a rotated secret value (`4823fcf71ff...`). The `.env` file has the original `nova-admin-secret-change-me`. Tests pull from `.env` via `conftest.py:28` (`os.getenv("NOVA_ADMIN_SECRET", "")`), so they send the stale secret and get 401 from auth-respecting services.

**Two reasonable fixes:**

1. **Rotate Redis back to env.** `redis-cli -n 1 DEL nova:config:auth.admin_secret`. Forces all services to revert to `.env`. Loses the rotated value (anyone holding it loses access).
2. **Have conftest read Redis first, env fallback.** Mirrors the service pattern. Tests stay valid through future rotations.

Recommendation: option 2 — better long-term posture, mirrors production behavior.

## Inference backend cluster — environment gate, not a fix

13 inference-backend tests fail because this dev env has no vLLM/SGLang running. The tests aren't broken — they're asserting capabilities that don't exist on this host. Mark with `pytest.mark.skipif(not has_inference_backend)` or split into a `--gpu-tests` opt-in marker.

## Files changed in this session

- `Makefile` (line 75): added `--with psycopg2-binary`
- `tests/test_sources.py` (lines 40, 62): `pytest.approx()` for float comparison
- `tests/test_voice.py` (lines 11-12, all `httpx.AsyncClient(...)`): added `HEADERS` constant + `headers=HEADERS` to every client init

## Next session

- Resolve admin-auth P0 (real security finding)
- Resolve `.env`/Redis secret divergence (option 2 above)
- Mark inference-backend tests with environment gate
- Add `requires_llm` marker to pipeline-behavior tests
- Triage the misc 6 one-offs individually

## Update — 2026-04-27 (Task 9): Groq 401 cluster resolved via local-only routing

The pipeline-behavior + maturation-phase 500s traced to a single root cause: the dev `GROQ_API_KEY` in `.env` was returning 401 Invalid API Key, and the gateway's default tier preferences put `groq/llama-3.3-70b-versatile` first for tier=mid/cheap. Per the user's stored preference ("local AI is primary"), fixed by routing locally rather than refreshing the cloud key:

1. Set `nova:config:llm.routing_strategy = local-only` in Redis db 1.
2. Overrode `nova:config:llm.tier_preferences` in Redis db 1 to a JSON dict putting Ollama models (`qwen2.5:7b`, `hermes3:8b`, `default-ollama`) at the head of every tier — without this, the resolver still returned the `groq/...` model name and the local-only override sent that string to Ollama, which 404s on unknown models.
3. Commented out `GROQ_API_KEY` in `.env` (gitignored, not committed) for durability across full-stack rebuilds. Restarted `llm-gateway`.

**Verification:** `POST /complete` with `tier=mid` returns 200 with `model=qwen2.5:7b`. Maturation tests `test_complex_goal_enters_scoping` and `test_speccing_produces_spec_and_transitions_to_review` now PASS (previously 500). Two remaining maturation failures are unrelated:
- `test_simple_goal_does_not_enter_maturation` — local model judges the simple-goal prompt as "complex" (LLM judgment quality, not env).
- `test_scoping_produces_scope_analysis` — `scope` returned as `str`, test iterates expecting dict (test/scoping shape mismatch, not env).

These two are now legitimate code/test work, not environment issues.
