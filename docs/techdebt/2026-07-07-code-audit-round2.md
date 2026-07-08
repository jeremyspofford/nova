# 2026-07-07 — Code Audit, Round 2 (net-new findings)

> **Scope:** a second review pass after the Brain + model-management work and
> the TD-01…09 fixes. Focuses on concerns not captured by
> `architecture/05-dead-code.md`, `06-refactor-plan.md`, or the first
> `2026-07-07-code-audit-findings.md`. Every finding was verified against the
> current source. Continues the TD-NN numbering (TD-10+).

**Method:** targeted reads of the auth resolution path, gateway routing,
this-session's new endpoints, and a scan for silent error handling + frontend
size/duplication. Two items surfaced from failing integration tests during the
Phase B merge (the trusted-network auth tests).

---

## Resolution status

- **TD-10** ✅ — trusted-network requests resolve to a synthetic **member**
  (user surface only), never the synthetic owner; role-gated management
  endpoints now reject network position. Verified: `/admin/users` → 403
  without creds, 200 with the admin secret.
- **TD-11** ✅ — under `local-first`, an unrecognized model triggers a
  throttled local re-sync before falling to cloud (closes the sync-stale
  cloud-prefix window; genuine cloud models unaffected).
- **TD-12** ✅ — api-reference memory section rewritten to the current
  `/api/v1/memory/*` OKF API.
- **TD-13** ✅ — trusted-network tests rewritten to the current posture.
- **TD-14** ✅ — parser extracted to `parse_library()` with a fixture-based
  unit test.
- **TD-16** ✅ — memory graph cached on a (file-count, max-mtime) signature.
- **TD-17** ✅ — cloud pricing shows a staleness warning past ~6 months.
- **TD-15** ⏸ deferred — Models.tsx split; pure refactor, schedule with
  regression headroom.

## Findings index

| ID | Sev | Area | Title | Effort |
|----|-----|------|-------|--------|
| TD-10 | **High** | Security | Role-gated *management* endpoints accept the trusted-network synthetic admin | M |
| TD-11 | Medium | Correctness/Cost | Local models with cloud-provider name prefixes can route to the cloud | S-M |
| TD-12 | Low | Docs | `api-reference.md` memory section documents the retired engram API | S |
| TD-13 | Low | Test honesty | Stale `test_trusted_networks.py` asserts removed bypass behavior | S |
| TD-14 | Low | Resilience | ollama.com popularity scraper is markup-coupled and untested | S |
| TD-15 | Low | Maintainability | `Models.tsx` is 1429 lines with duplicated recommendation-card markup | M |
| TD-16 | Low | Perf | Memory graph is re-parsed from disk on every request | S |
| TD-17 | Low | Cost accuracy | Cloud pricing is a hand-maintained snapshot with no staleness signal | S |

---

## TD-10 — Management endpoints accept the trusted-network synthetic admin  🔴 High / Security

**Where:** `orchestrator/app/auth.py` (`get_current_user` trusted-network path)
+ every role-gated route using `UserDep` + `has_min_role(...)`, notably
`auth_router.py` `admin_create_user` / `list_all_users` / `update_user_admin`
/ `delete_user_endpoint`.

**Problem.** The July-1 fix (SEC2) made `require_admin` (the X-Admin-Secret /
JWT admin gate) explicitly refuse network position — good. But the **user
management** endpoints don't use `require_admin`; they use `UserDep` and then
check `has_min_role(user.role, "admin")`. And `get_current_user`, on a
trusted-network request, returns a **synthetic owner/admin identity** (auth.py
resolves `is_trusted_network` to the seeded admin). So the role check passes,
and a request from any trusted CIDR — **no credentials** — can list, create,
role-change, and hard-delete users.

Verified: `tests/test_rbac.py::test_list_users_without_auth` asserts
`/api/v1/admin/users` returns 401/403 without auth; it returns **200**. The
same class of hole SEC2 closed for `require_admin`, still open on the
UserDep+role path.

**Impact.** Inconsistent posture: `/api/v1/config` (require_admin) rejects
network position while `/api/v1/admin/users` (UserDep+role) grants a synthetic
admin. Default `trusted_networks` is loopback-only, so real-world exposure
needs the operator to widen it (or a `trusted_proxy_header` misconfig makes
dashboard-proxied requests look trusted — the exact July-1 vector). But
"delete any user, credential-free, from the LAN" is High.

**Fix.** The trusted-network synthetic identity must be capped at the **USER
surface** (chat/conversations/viewing). Role-gated management endpoints should
require a real authenticated identity: either (a) route them through
`require_admin` semantics, or (b) have `has_min_role` reject the synthetic
trusted-network principal (mark it, e.g. `user.id is None and
user.source == "trusted-network"`, and treat it as role `guest` for
management checks). Pair with TD-13 (the tests already encode the target).

**Effort:** M — the change is small but security-critical; needs the auth
resolution audited so a legit logged-in LAN operator (JWT) is unaffected, and
the stale tests flipped.

---

## TD-11 — Local models with cloud-provider name prefixes can route to the cloud  🟡 Medium / Correctness + Cost

**Where:** `llm-gateway/app/registry.py` `get_provider()` / `_is_local_model()`.

**Problem.** LM Studio hosts models under publisher-prefixed ids like
`openai/gpt-oss-20b`, `google/gemma-4-12b-qat`. Routing keeps such a model
local only if `_is_local_model(model)` is true, which requires
`sync_lmstudio_models()` to have registered it into `_local_models`. In the
gap where sync is stale/failed/not-yet-run (startup, LM Studio restarted, a
model downloaded since the last sync), `_is_local_model("openai/gpt-oss-20b")`
returns **False**, routing falls through to
`MODEL_REGISTRY.get("openai/gpt-oss-20b")`, and the cloud **OpenAI** provider
claims it by prefix — the prompt is sent to api.openai.com (billable + data
egress) or fails on a missing key. This is exactly what broke the LM Studio
**Test** button (fixed to force-local in `d987e01`); the general chat/pipeline
routing still relies on sync freshness.

**Impact.** Prompt exfiltration to a cloud provider + unexpected cost, in the
sync-stale window, for any local model whose name collides with a cloud prefix.
Silent — it just "works" against the wrong backend.

**Fix.** When `routing_strategy` is `local-first`/`local-only` **and the active
local backend is reachable**, prefer it for an unknown model before cloud
name-matching. Belt-and-suspenders: namespace local model ids (e.g.
`lmstudio/openai/gpt-oss-20b`) so they can't collide with cloud prefixes.

**Effort:** S-M (routing change is small but central; add a test that a
cloud-prefixed local model routes local under local-first).

---

## TD-12 — api-reference.md memory section documents the retired engram API  🟠 Low / Docs

**Where:** `website/src/content/docs/nova/docs/api-reference.md` §Memory Service.

**Problem.** The section shows `/api/v1/memories/*` (semantic search, `facts`,
`tier`, per-agent context) — the **engram** API removed when OKF became the
only backend. The live surface is `/api/v1/memory/*` (context/graph/item/
events/stats). A stopgap note + the new Brain endpoints were added this
session, but the bulk of the section is misleading to integrators.

**Fix.** Rewrite the section to the current OKF API (mirror
`services/memory-service.md`, which is correct). **Effort:** S.

---

## TD-13 — Stale trusted-network tests assert removed bypass behavior  🟠 Low / Test honesty

**Where:** `tests/test_trusted_networks.py` (`TestTrustedNetworkAuthBypass`,
`TestTrustedNetworkConfigSeeded`).

**Problem.** These assert `/api/v1/config` returns **200** without credentials
from a trusted network — the pre-SEC2 bypass. It now returns 401, so they
fail; the two seeded-config tests also read `/config` with no admin header and
fail. They test behavior that was deliberately removed.

**Fix.** Update to the current posture: admin endpoints require auth even from
a trusted network (assert 401 without creds, 200 with admin creds); the *user*
surface (`/agents`, `/conversations`) still accepts trusted network. Read
`/config` with admin headers in the seeded-key checks. Ties to TD-10 (the
`test_list_users_without_auth` case encodes the management-endpoint target).
**Effort:** S.

---

## TD-14 — ollama.com popularity scraper is markup-coupled and untested  🟠 Low / Resilience

**Where:** `recovery-service/app/inference/catalog.py`.

**Problem.** `popular_models()` parses `ollama.com/library` HTML with per-block
regexes keyed on `x-test-*` attributes + registry-manifest fetches for sizes.
It fails safe (any error → curated fallback), but pull-counts already parse for
only ~half the rows, and a markup change silently degrades the whole live
source with no signal. No test pins the parser.

**Fix.** Add a parser unit test against a captured HTML fixture (asserts
names/sizes/param-variants extract), so a markup drift is caught in CI rather
than silently. Consider an official JSON source if one exists. **Effort:** S.

---

## TD-15 — Models.tsx is 1429 lines with duplicated recommendation-card markup  🟠 Low / Maintainability

**Where:** `dashboard/src/pages/Models.tsx`.

**Problem.** One file holds the active-backend card, per-local-backend sections,
two recommendation grids (ollama popular/curated **and** the vLLM/SGLang search
grid), the cloud-provider grid, cloud recommendations, and routing stats. The
recommendation **card** markup is near-duplicated between the ollama grid and
the vLLM grid. The `LocalModelsTable` + `CloudRecommendations` extraction this
session started the pattern; the rest should follow.

**Fix.** Extract `RecommendationCard`, `OllamaSection`, `VllmSection`,
`CloudProvidersSection` into `pages/models/*`. **Effort:** M. Pure refactor —
schedule when there's regression headroom (it's the hottest-edited page).

---

## TD-16 — Memory graph re-parsed from disk on every request  🟠 Low / Perf

**Where:** `memory-service/app/backends/okf/backend.py` `graph()`.

**Problem.** `GET /api/v1/memory/graph` reads + parses **every** bundle file
and re-resolves all wiki-links on each call (O(files)). The Brain page fetches
it on mount and re-fetches after every edit/delete. Fine at today's bundle
size (single digits); a few hundred files makes each Brain load a full
re-parse.

**Fix.** Cache the computed graph keyed on the BM25 index version/mtime (the
index already self-heals on file changes), invalidate on write. **Effort:** S.

---

## TD-17 — Cloud pricing is a hand-maintained snapshot with no staleness signal  🟠 Low / Cost accuracy

**Where:** `data/recommended_cloud_models.json` + `CloudRecommendations.tsx`.

**Problem.** Prices drift as providers change rates; the only guard is the
`updated: "2026-07"` string. Nothing flags when it's months stale, so a user
could budget off numbers that are quietly wrong.

**Fix.** Surface an age warning in the UI when `updated` is older than N months
(cheap, honest). Optional stretch: a periodic refresh (intel-worker) against a
pricing source. **Effort:** S. (Acknowledged design tradeoff; documenting for
visibility.)

---

## Proposed sequencing

1. **TD-10 + TD-13** — the security posture fix and the tests that encode it,
   together. Highest value.
2. **TD-11** — routing correctness; standalone.
3. **TD-12, TD-14, TD-16, TD-17** — small, independent; bundle.
4. **TD-15** — pure refactor; schedule with regression headroom.
