# 2026-07-07 — Code-Quality / Security / Perf Audit (net-new findings)

> **Scope:** a fresh pass over the live source for concerns the 2026-07-05
> `architecture/05-dead-code.md` + `06-refactor-plan.md` audit did not capture.
> Every finding below was verified against current code (commit at audit time).
> Items already covered by 05/06 are **not** re-listed; see "Deliberately not
> re-flagged" at the bottom.

**Method:** targeted greps for high-signal anti-patterns (dynamic SQL,
blocking-in-async, swallowed exceptions, SSRF, deserialization, unbounded
queries, missing indexes, XSS surface, resource-leak patterns) followed by
source reads to confirm or dismiss each hit. ~9 net-new findings; 3 dismissed
during verification (recorded so the next pass doesn't re-chase them).

---

## Resolution status (updated 2026-07-07)

Addressed in the `feature/safe-defaults` line:

- **TD-01** ✅ — resolve-and-check SSRF validator (all resolved IPs, wildcard-DNS
  suffixes, fail-closed) + `browser_open`/`browser_navigate` guard + `test_ssrf.py`.
  Deferred: the connect-time IP-pin transport (TOCTOU close).
- **TD-03** ✅ — the three genuinely-unbounded reads capped at `LIMIT 500` (the
  other flagged sites already had LIMIT/OFFSET).
- **TD-04** ✅ — migration `102_fk_index_coverage.sql` adds leading-column indexes
  on the append-heavy tables' FK/filter columns.
- **TD-06** ✅ — stimulus-emit failures now `log.debug` instead of silent `pass`.
- **TD-07** ✅ — trusted-network config-refresh fallback logs at WARNING.
- **TD-08** ✅ — dashboard CSP header (verified: SPA, Brain canvas, same-origin
  fetch/SSE render under it).
- **TD-09** ✅ — browser-worker closes its admin-auth Redis connection on shutdown.
- **TD-02** ⏸ deferred — httpx pooling refactor; land with Phase 3 consolidation
  so services aren't re-plumbed twice (per this doc's own recommendation).
- **TD-05** ⏸ deferred — shared `nova_worker_common` redis module; same reasoning.

## Findings index

| ID | Sev | Area | Title | Effort |
|----|-----|------|-------|--------|
| TD-01 | **High** | Security | SSRF validator defeated by DNS rebinding (no resolution check) | M |
| TD-02 | Medium | Perf/Consistency | Per-tool-call `httpx.AsyncClient` creation — no pooling, ignores shared factory | S-M |
| TD-03 | Medium | Perf/DoS | Unbounded `SELECT *` list endpoints (comments, crawl log, PRs, approvals, credentials) | S |
| TD-04 | Medium | Perf | FK/filter-column index coverage unverified (raw asyncpg, no ORM auto-index) | S-M |
| TD-05 | Low | Duplication | Redis-client logic reimplemented across 7+ service homes; no shared module | M |
| TD-06 | Low | Observability | Silent `except Exception: pass` on stimulus emit (runner.py) | XS |
| TD-07 | Low | Observability/Security | DEBUG-level failure log for trusted-network config refresh | XS |
| TD-08 | Low | Security/Defense-in-depth | No Content-Security-Policy header on dashboard | XS |
| TD-09 | Low | Resource leak | browser-worker opens Redis (admin-auth middleware) with no `close_redis` in lifespan | XS |

---

## TD-01 — SSRF validator defeated by DNS rebinding  🔴 High / Security

**Where:** `nova-worker-common/nova_worker_common/url_validator.py` — `validate_url()`.

**Problem.** The validator is hostname-*string*-based. It (1) checks the
hostname against a static `BLOCKED_HOSTS` set, then (2) tries
`ipaddress.ip_address(hostname)` — but wraps that in `except ValueError: pass`.
For any **domain name** (not an IP literal) the `ip_address()` call raises
`ValueError`, the exception is swallowed, and `validate_url` returns `None`
(safe). httpx then fetches the URL, resolves the domain via DNS, and connects
to whatever IP the DNS returns — including private/loopback/metadata IPs.

**Bypass vectors (confirmed by reading the code):**
- `http://localtest.me/…` — well-known domain resolving to `127.0.0.1`.
- `http://burpcollaborator-style-rebind/…` or any attacker domain with an A
  record pointing to `127.0.0.1`, `10.0.0.x`, or `169.254.169.254`.
- Wildcard-DNS services: `<anything>.nip.io`, `<ip>.sslip.io` — e.g.
  `http://127.0.0.1.nip.io/` resolves to `127.0.0.1` but is a valid hostname
  string, so `ip_address()` raises and the check passes.
- TOCTOU rebind: a domain that returns a public IP at validation time and a
  private IP at fetch time (the gap is broader than just the no-resolve case).

**Impact.** `validate_url` is the **sole** SSRF gate for three agent-reachable
surfaces (verified by grep — all import the same function):
- `web_tools.py:_execute_web_fetch` (the `web_fetch` agent tool — prompt-injectable),
- `intel_router.py` feed-URL create/update,
- `knowledge_router.py` source-URL create/update.

A prompt-injected agent (or a misconfigured feed) can therefore reach Nova's
internal services (`http://orchestrator:8000`, `http://llm-gateway:8001`,
`http://postgres` is blocked by hostname but `postgres` resolves to the DB IP
via Docker DNS — reachable through the gateway service's own stack), the Redis
container, or cloud-metadata endpoints via a DNS alias. The `web_fetch`
follows **no redirects** but validates per-hop, so direct fetch is the vector;
`browser_open` (browser-worker) does **not** call `validate_url` at all (separate
gap — see note).

**Fix (pragmatic, defeats the common case):**
1. In `validate_url`, when the hostname is not an IP literal, **resolve it**
   (`asyncio.getaddrinfo` / `socket.getaddrinfo`) and validate **every**
   returned address against `is_private / is_loopback / is_link_local /
   is_reserved / is_multicast`. Reject if any resolved IP is internal.
2. Block the wildcard-DNS services explicitly (`nip.io`, `sslip.io`,
   `localtest.me`, `xip.io`) in `BLOCKED_HOSTS` as a belt-and-suspenders.
3. (Robust, optional) Use a custom `httpx.AsyncHTTPTransport` that validates
   the resolved IP at connect time and pins it, closing the TOCTOU window.
   This is the gold-standard fix but heavier; step 1 covers ~all real attacks.
4. **Apply the same validator to `browser_open`** in `browser_tools.py` —
   today the browser worker navigates to any URL with no SSRF check at all
   (it's a separate surface that happens to share the "agent picks URL"
   threat model).

**Effort:** M (the resolve-and-check is ~20 lines; the transport pin is +1-2h;
browser_open adoption is a one-line guard + test).

**Tests to add:** `tests/test_ssrf.py` — assert `validate_url` rejects
`localtest.me`, `127.0.0.1.nip.io`, and a mocked rebind domain; assert
`web_fetch` returns `Blocked:` for each.

---

## TD-02 — Per-tool-call `httpx.AsyncClient` creation (no pooling) 🟡 Medium / Perf + Consistency

**Where:** `orchestrator/app/tools/{web,memory,browser}_tools.py`,
`quality_scorer.py`, `notifier.py`, `quality_router.py`, `quality_loop/*`,
`oauth.py`, `health.py`, `capabilities/{router,credentials}.py`,
`tools/{github,diagnosis,checkpoint}_tools.py`.

**Problem.** These files create a fresh `async with httpx.AsyncClient(...)`
on **every invocation**. Each call builds a new connection pool, does a new
TCP+TLS handshake, and tears it down. A single agent turn can fire 5-20 tool
calls (search → fetch → memory → browser), each paying the handshake cost to
the same downstream services.

Meanwhile:
- `orchestrator/app/clients.py` already provides **pooled module-level
  singletons** (`get_memory_client()`, `get_llm_client()`,
  `get_orchestrator_client()`) with `close_clients()` wired into lifespan
  shutdown — but only the 3 core downstream clients use them; **every tool
  bypasses them**.
- `nova-worker-common/nova_worker_common/http_client.py` offers a
  `create_client()` factory — also unused by the tools.

So the pattern exists and is correct in `clients.py`; it just isn't adopted
where the hot path lives.

**Impact.** Latency (handshakes on every call — most painful to localhost
services under CPU inference), and inconsistency (two ways to make an HTTP
call, only one of which pools). Not a correctness bug.

**Fix.** Either:
- (a) Route tool HTTP through the existing `clients.py` singletons (extend
  with a `get_web_client()`, `get_notifier_client()` etc. as needed), or
- (b) Adopt `nova_worker_common.http_client.create_client` for module-level
  pooled clients in each tool module, with a shared `close_all()` registered
  in `main.py` lifespan shutdown (mirrors the `close_clients()` pattern).

Keep per-call `async with` only for genuinely one-off low-frequency calls
(oauth callback, health probes).

**Effort:** S-M (mechanical; the risk is making sure every new pooled client
has a shutdown close — add a test asserting `close_*` is called in lifespan).

---

## TD-03 — Unbounded `SELECT *` list endpoints 🟡 Medium / Perf + DoS

**Where (confirmed by grep, `SELECT * FROM <t>` with no `LIMIT`):**

| File:line | Table | Risk |
|---|---|---|
| `intel_router.py:487,609` | `comments` | grows with activity; agent-creatable |
| `goals_router.py:425` | `comments` | same |
| `knowledge_router.py:200` | `knowledge_crawl_log` | grows per crawl run |
| `router.py:1616` | `selfmod_prs` | grows with self-mod work |
| `capabilities/consent.py:211` | `approval_requests` | grows over time |
| `capabilities/credentials.py:299,306` | `capability_credentials` | bounded by tenant but still unbounded |

Small reference tables (`skills`, `rules`, `mcp_servers`, `agent_endpoints`)
are also unbounded but fine — they're operator-managed and small.

**Impact.** As these tables grow (a chatty agent, a long-running crawl, months
of approvals), a list call returns the entire table into memory and serializes
it. No hard cap. A bad actor who can create rows (or just time) can degrade
list-endpoint latency and memory. Low exploitability pre-release, but it's the
kind of thing that bites at scale.

**Fix.** Add `LIMIT $N OFFSET $M` (or cursor pagination) to the six growing
tables; cap `limit` query params (some already use `Query(le=200)`, these
don't). Return a total-count for the paginator where the UI needs it.

**Effort:** S (uniform change; the `intel_router` recommendation list already
shows the parameterized `LIMIT/OFFSET` pattern to copy).

---

## TD-04 — FK / filter-column index coverage unverified 🟡 Medium / Perf

**Where:** `orchestrator/app/migrations/*.sql` (97 migrations, 103 index stmts).

**Problem.** Raw asyncpg means **no ORM auto-indexing of foreign keys**.
Postgres indexes primary keys and unique constraints automatically, but **not**
FK columns. A grep of query patterns shows the most-filtered columns are:

```
17× WHERE task_id        12× WHERE tenant_id      4× WHERE entity_type
 3× WHERE user_id         3× WHERE recommendation_id   3× WHERE pod_id
 3× WHERE hook_id         3× WHERE conversation_id     2× WHERE session_id
```

Some of these are certainly indexed (there are 103 index statements), but the
coverage is **unverified** — there's no guarantee the FK columns that appear in
`WHERE`/`JOIN` are all covered. At current row counts seq scans are fine; as
`tasks`, `approval_requests`, `capability_audit`, `comments` grow, missing FK
indexes turn into full-table scans on every join.

**Fix.** One-time audit pass: list all FK columns (and the high-freq filter
columns above), cross-reference against `pg_indexes` / the migrations, add
`CREATE INDEX IF NOT EXISTS` for any missing. Ship as a single idempotent
migration (e.g. `094_fk_index_coverage.sql`).

**Effort:** S-M (the audit is the work; the migration is mechanical). Verify
with `EXPLAIN` on the top queries before/after.

---

## TD-05 — Redis-client logic reimplemented across 7+ service homes 🟠 Low / Duplication

**Where.** `get_redis()` / `close_redis()` live in:
`orchestrator/app/store.py`, `orchestrator/app/stimulus.py`,
`cortex/app/budget.py`, `cortex/app/stimulus.py`, `chat-api/app/session.py`,
`memory-service/app/redis_client.py`, `recovery-service/app/redis_client.py`,
`llm-gateway/app/discovery.py`, `voice-service/app/main.py`.

**Problem.** `nova-worker-common` ships shared `http_client.py`, `queue.py`,
`rate_limiter.py`, `admin_secret.py`, `service_auth.py` — but **no shared
Redis module**. Each service hand-rolls a module-level `_redis` singleton with
its own `decode_responses` choice, db-number handling, and close logic. The two
`redis_client.py` files (`memory-service` 23 lines sync vs `recovery-service`
98 lines async with per-db support) are a case study in the drift: same job,
different signatures, different capabilities.

**Impact.** Drift risk (the CLAUDE.md "every service must close_redis in
lifespan" rule is enforced by convention, not by a shared primitive that makes
it automatic — see TD-09 for a concrete miss). Connection-leak bugs get
copy-pasted. Inconsistent `decode_responses` settings cause subtle bytes-vs-str
bugs across service boundaries.

**Fix.** Add `nova_worker_common/redis_client.py` with a per-db factory +
`close_all()`, adopt across services (one PR per service to keep diffs
reviewable). Don't unify the *config* (each service's db number is intentional),
just the *connection lifecycle*. Pairs naturally with the consolidation plan
(`06` §C1–C3) — do it as services fold into the hub.

**Effort:** M (mostly mechanical; coordinate with consolidation to avoid
touching a service twice).

---

## TD-06 — Silent `except Exception: pass` on stimulus emit 🟠 Low / Observability

**Where:** `orchestrator/app/agents/runner.py:149-150` and `:288-289`.

```python
await emit_stimulus("message.received", {...})
except Exception:
    pass
```

**Problem.** If the stimulus bus (Redis pubsub) is broken, the agent loop
continues silently — zero log line, zero metric. The stimulus events drive the
dashboard's live brain view and the cortex reactive layer; a silent failure
here looks like "cortex stopped reacting" with no trace.

**Impact.** Pure observability gap. Not a correctness bug (swallowing a
non-critical side-channel emit is fine per the fault-tolerant convention); the
issue is that it's *invisible* even at DEBUG.

**Fix.** `log.debug("stimulus emit failed: %s", e)` — minimum. Optionally
count and WARN once per N failures to surface a sick Redis without flooding.

**Effort:** XS.

---

## TD-07 — DEBUG-level failure log for trusted-network config refresh 🟠 Low / Security-adjacent

**Where:** `orchestrator/app/trusted_network.py:112`.

```python
except Exception:
    # DB unavailable — keep using previous cached or fallback values
    self._cache_ts = now
    log.debug("Failed to refresh trusted network config from DB, using cached/fallback values")
```

**Problem.** The trusted-network bypass (audit 05 §S4 — the mechanism behind
the 2026-07-01 factory-reset incident) falls back to cached/fallback CIDRs when
the DB is unreachable. That fallback is logged at **DEBUG**, which is invisible
at the default `LOG_LEVEL=INFO`. CLAUDE.md is explicit: *"Never log critical
failures at DEBUG — they become invisible in production."* A security-adjacent
config silently falling back to potentially-more-permissive CIDRs qualifies.

The other DEBUG-failure sites in `runner.py` (`:640` memory cache lookup,
`:698` memory pre-warm, `:722` platform identity load) are **genuinely
non-critical best-effort** paths — DEBUG is defensible there. Only the
trusted-network one is security-adjacent.

**Fix.** Bump `trusted_network.py:112` to `log.warning(...)`. Leave the
runner.py best-effort ones at DEBUG, but consider a one-time INFO on first
fallback so a persistently-sick DB is observable without spamming.

**Effort:** XS (one-line log-level change + a test asserting the WARN fires).

---

## TD-08 — No Content-Security-Policy header on the dashboard 🟠 Low / Defense-in-depth

**Where:** `dashboard/` nginx config + orchestrator (no CSP set anywhere —
verified by grep).

**Context.** The XSS surface is actually **small and well-handled**:
- The one `dangerouslySetInnerHTML` site (`ArtifactRenderer.tsx:70`) renders
  Mermaid SVG that is run through `DOMPurify.sanitize(..., {USE_PROFILES:
  {svg: true, svgFilters: true}})` *and* Mermaid's `securityLevel: 'strict'`.
  Properly sanitized. ✅ (dismissed as a finding during verification)
- Agent markdown is rendered via `ReactMarkdown`, which escapes by default. ✅

**The residual concern:** the admin secret lives in `localStorage`
(`api.ts:9` — documented design). With no CSP, any future XSS sink (a new
`dangerouslySetInnerHTML`, a misconfigured markdown renderer, a third-party
script) exfiltrates the admin secret trivially. CSP is cheap defense-in-depth
that turns a future XSS into a no-op.

**Fix.** Add a restrictive CSP to the dashboard nginx config (`default-src
'self'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none';
base-uri 'self'`). Mermaid + React work under this. Adjust if inline styles
are needed (`style-src 'self' 'unsafe-inline'` is the usual pragmatic allow).

**Effort:** XS (config + a smoke test that the dashboard + brain canvas
render). Note: the Brain page uses a WebGL canvas (rapier3d) — verify CSP
doesn't break `worker-src`/`wasm-unsafe-eval`.

---

## TD-09 — browser-worker opens Redis with no `close_redis` in lifespan 🟠 Low / Resource leak

**Where:** `browser-worker/app/main.py:67` (passes `redis_url` to the
admin-auth middleware from `nova-worker-common`), `browser-worker/app/config.py:25`.

**Problem.** `browser-worker/app/main.py` has **zero** `close_redis`/`aclose`
calls (grep-confirmed). The service passes `redis_url=settings.redis_url` into
the admin-auth middleware, which caches a Redis connection (db11). That
connection is never closed on shutdown — exactly the leak pattern CLAUDE.md
calls out ("Connection leaks accumulate across restarts").

**Impact.** Low (browser-worker is profile-gated, restarts are infrequent), but
it's a real leak and a direct violation of the documented rule — and TD-05
(extracting a shared redis module) would have made this automatic.

**Fix.** Add `close_redis()` (or the shared equivalent from TD-05) to the
`browser-worker/app/main.py` lifespan `shutdown` handler. One-line guard if
the middleware exposes a close; otherwise expose one in `nova-worker-common`'s
`service_auth`.

**Effort:** XS.

---

## Proposed sequencing

These are independent of the 05/06 refactor phases. Suggested order by
risk-reduction-per-hour:

1. **TD-01 (SSRF)** — do first; it's the only High and it's prompt-reachable.
   Standalone, no deps. ~M.
2. **TD-09, TD-06, TD-07** — the XS trio; bundle into one "observability + leak
   hygiene" PR. Half a day.
3. **TD-03 (unbounded queries)** — small, standalone, prevents a future
  pager. S.
4. **TD-02 (httpx pooling)** — bigger mechanical pass; do after the
   consolidation merges (06 §C1–C3) so you don't rework HTTP plumbing in
   services about to be folded into the hub. S-M.
5. **TD-04 (FK indexes)** — ship alongside whatever migration follows the
   current head; the audit pass is the work. S-M.
6. **TD-05 (shared redis module)** — coordinate with consolidation; do it as
   services fold in. M.
7. **TD-08 (CSP)** — anytime; lowest urgency, cheap. XS.

**Suggested timing vs. the existing plan:** TD-01, TD-06/07/09, and TD-03 slot
cleanly into the existing Phase 1 ("Make the suite honest") or as a Phase 1.5
since they're small and self-contained. TD-02/05 are best folded into Phase 3
(consolidation). TD-04 rides with the next migration. None block the shipped
Phases 0–2 or the in-flight Phase 4 autonomy work.

---

## Deliberately NOT re-flagged (verified clean or already known)

- **Dynamic SQL is parameterized.** The f-string `SELECT`/`UPDATE` builders in
  `intel_router.py`, `goals_router.py`, `skills.py`, `rules.py`, `users.py`,
  `capabilities/*` interpolate **only column names and `$N` placeholders**;
  all user values pass through `*args`/`*values`. Correct asyncpg pattern. Not
  an injection risk.
- **No blocking calls in async paths.** No `time.sleep` / `requests.` /
  `subprocess.run` in async code (grep-clean; they use `asyncio.sleep` /
  httpx). ✅
- **No dangerous deserialization.** No `eval`/`exec`/`pickle`/`yaml.load`/
  `shell=True` (the one `redis.eval` is Lua, correctly `noqa`'d). ✅
- **`dangerouslySetInnerHTML` SVG is sanitized** (DOMPurify + Mermaid
  `securityLevel: 'strict'`) — dismissed as a finding. See TD-08 context.
- **`close_clients()` is wired into orchestrator lifespan shutdown**
  (`main.py:565`) and the flag HTTP client is closed (`:534`). ✅
- **Memory BM25 `refresh()` on every write** — already a watch item in
  `05` §6; not re-flagged.
- **Large files** (`executor.py` 2132, `router.py` 1701, `runner.py` 1394) —
  already in `06` §R1–R3; not re-flagged.
- **Home-mount rw / `.env` rw / docker-socket / default admin secret / trusted-
  network bypass model** — already `05` §S1–S5; not re-flagged.

---

## Open questions for the operator

1. **TD-01 scope:** ship just the resolve-and-check (step 1+2), or also the
   custom-transport IP pin (step 3) and the `browser_open` guard (step 4)?
   Recommendation: 1+2+4 now, 3 deferred unless a real rebind is observed.
2. **TD-02 vs consolidation:** apply the pooled-client refactor now, or defer
   to land with Phase 3 so services aren't re-plumbed twice?
3. **TD-04:** want a full `EXPLAIN`-backed index audit, or just add the
   obvious FK indexes and move on?
